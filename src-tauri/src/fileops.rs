#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "移動・名前変更・コピーを呼ぶコマンドはタスク3以降で作る"
    )
)]

use std::collections::HashSet;
use std::ffi::{CString, OsStr};
use std::fmt::Display;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, Transaction};
use unicode_normalization::UnicodeNormalization;

use crate::library::Library;

pub enum OnConflict {
    Number,
    Fail,
}

pub struct Request<'a> {
    pub kind: &'a str,
    pub target_id: Option<i64>,
    pub copy: bool,
    pub src: &'a Path,
    pub dst_dir: &'a Path,
    pub name: &'a str,
    pub on_conflict: OnConflict,
}

#[derive(Debug)]
pub struct PendingOp {
    pub id: i64,
    pub kind: String,
    pub target_id: Option<i64>,
    pub copy: bool,
    pub src: PathBuf,
    pub dst: PathBuf,
}

pub type Apply<'a> = &'a dyn Fn(&Transaction, &PendingOp) -> Result<(), String>;

const TMP_PREFIX: &str = ".kura-tmp-";

fn err(e: impl Display) -> String {
    e.to_string()
}

/// APFS と exFAT の初期設定に合わせ、正規化（NFC）と大文字・小文字の違いを無視して名前を比べるための鍵
fn key(name: &OsStr) -> String {
    name.to_string_lossy()
        .nfc()
        .collect::<String>()
        .to_lowercase()
}

fn nfc(name: &OsStr) -> String {
    name.to_string_lossy().nfc().collect()
}

/// 名前があるかを、実際のフォルダの中身で調べる。大文字・小文字は区別する
/// （大文字・小文字を区別しないボリュームでは Path::exists が a.jpg と A.jpg を見分けないため）
fn present(path: &Path) -> bool {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    let name = nfc(name);
    fs::read_dir(dir).is_ok_and(|entries| entries.flatten().any(|e| nfc(&e.file_name()) == name))
}

fn rename_excl(from: &Path, to: &Path) -> Result<(), String> {
    let f = CString::new(from.as_os_str().as_bytes()).map_err(err)?;
    let t = CString::new(to.as_os_str().as_bytes()).map_err(err)?;
    // SAFETY: f と t は NUL 終端の文字列
    // 存在を確かめてから rename すると、その間に置かれたファイルを上書きしうるので、RENAME_EXCL で一度に行う
    if unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let mut e = io::Error::last_os_error();
    if e.raw_os_error() == Some(libc::ENOTSUP) {
        // shortcut: exFAT は RENAME_EXCL に対応しない（ENOTSUP）ので、確かめてから rename する。
        // その間に Finder で同名のファイルが置かれると上書きされる。問題が出たら、移動先に空のファイルを先に作って名前を押さえる方式にする
        e = match to.exists() {
            true => io::Error::from_raw_os_error(libc::EEXIST),
            false => match fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(e) => e,
            },
        };
    }
    Err(format!(
        "{} を {} に移せません（{e}）",
        from.display(),
        to.display()
    ))
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

pub fn free_name(
    dir: &Path,
    name: &str,
    except: Option<&OsStr>,
    on_conflict: OnConflict,
) -> Result<String, String> {
    let taken: HashSet<String> = fs::read_dir(dir)
        .map_err(|e| format!("フォルダを読めません（{}、{e}）", dir.display()))?
        .map(|e| e.map(|e| e.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?
        .iter()
        .filter(|n| Some(n.as_os_str()) != except)
        .map(|n| key(n))
        .collect();
    if !taken.contains(&key(name.as_ref())) {
        return Ok(name.to_string());
    }
    if let OnConflict::Fail = on_conflict {
        return Err(format!("同じ名前のファイルかフォルダがあります（{name}）"));
    }
    let (stem, ext) = split_ext(name);
    Ok((2..)
        .map(|n| match ext {
            "" => format!("{stem} ({n})"),
            _ => format!("{stem} ({n}).{ext}"),
        })
        .find(|n| !taken.contains(&key(n.as_ref())))
        .unwrap())
}

/// ファイルかフォルダを、上書きせずに移動・名前変更・コピーする。返り値は移した先（ライブラリからの相対パス）
///
/// 手順：1) 予定を pending_ops に記録してコミット → 2) RENAME_EXCL で rename → 3) apply と予定の削除を1トランザクションで。
/// どこで止まっても、recover が実ファイルの位置を見て完了させるか取り消す
pub fn transfer(lib: &mut Library, req: Request, apply: Apply) -> Result<PathBuf, String> {
    let src_abs = lib.root.join(req.src);
    if !src_abs.exists() {
        return Err(format!("移動元が見つかりません（{}）", src_abs.display()));
    }
    let name: String = req.name.nfc().collect();
    let same_dir = !req.copy && req.src.parent() == Some(req.dst_dir);
    if same_dir && req.src.file_name().map(nfc).as_deref() == Some(&name) {
        return Ok(req.src.to_path_buf());
    }
    let except = if same_dir { req.src.file_name() } else { None };
    let case_only = except.is_some_and(|n| key(n) == key(name.as_ref()));
    let name = free_name(&lib.root.join(req.dst_dir), &name, except, req.on_conflict)?;
    let dst = req.dst_dir.join(name);

    let op = record(lib, req.kind, req.target_id, req.copy, req.src, &dst)?;
    let tmp = lib.root.join(tmp_path(&op));
    let dst_abs = lib.root.join(&dst);
    let result = if req.copy {
        fs::copy(&src_abs, &tmp)
            .map_err(|e| format!("{} をコピーできません（{e}）", src_abs.display()))
            .and_then(|_| rename_excl(&tmp, &dst_abs))
    } else if case_only {
        // exFAT では rename_excl の存在確認が a.jpg と A.jpg を同じ名前とみなして失敗するので、一時的な名前を経由する
        rename_excl(&src_abs, &tmp).and_then(|_| rename_excl(&tmp, &dst_abs))
    } else {
        rename_excl(&src_abs, &dst_abs)
    };
    let result = result.and_then(|_| finish(lib, &op, apply));
    if let Err(e) = result {
        // 失敗した操作も、起動時と同じ後始末で元に戻すか完了させる。戻せなければ予定が残り、次の起動時に知らせる
        if let Err(e2) = settle(lib, &op, apply) {
            log::error!("操作 {} を後始末できません：{e2}", op.id);
        }
        return Err(e);
    }
    Ok(dst)
}

fn record(
    lib: &Library,
    kind: &str,
    target_id: Option<i64>,
    copy: bool,
    src: &Path,
    dst: &Path,
) -> Result<PendingOp, String> {
    let to_str = |p: &Path| {
        p.to_str()
            .map(str::to_string)
            .ok_or(format!("パスを扱えません（{}）", p.display()))
    };
    lib.conn
        .execute(
            "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![kind, target_id, copy, to_str(src)?, to_str(dst)?],
        )
        .map_err(err)?;
    Ok(PendingOp {
        id: lib.conn.last_insert_rowid(),
        kind: kind.to_string(),
        target_id,
        copy,
        src: src.to_path_buf(),
        dst: dst.to_path_buf(),
    })
}

/// 移動先と同じフォルダに置く、操作ごとの一時的な名前。. で始まるので画像として扱われない
fn tmp_path(op: &PendingOp) -> PathBuf {
    op.dst.with_file_name(format!("{TMP_PREFIX}{}", op.id))
}

fn finish(lib: &mut Library, op: &PendingOp, apply: Apply) -> Result<(), String> {
    let tx = lib.conn.transaction().map_err(err)?;
    apply(&tx, op)?;
    drop_op(&tx, op)?;
    tx.commit().map_err(err)
}

fn drop_op(conn: &Connection, op: &PendingOp) -> Result<(), String> {
    conn.execute("DELETE FROM pending_ops WHERE id = ?1", [op.id])
        .map(|_| ())
        .map_err(err)
}

/// 予定1つを、実ファイルの位置に合わせて完了させるか取り消す。どちらとも決められなければ false を返し、予定を残す
fn settle(lib: &mut Library, op: &PendingOp, apply: Apply) -> Result<bool, String> {
    let tmp = lib.root.join(tmp_path(op));
    if present(&tmp) {
        // 一時的な名前が残っている＝移動先への rename は起きていない
        if op.copy {
            fs::remove_file(&tmp).map_err(err)?;
        } else {
            rename_excl(&tmp, &lib.root.join(&op.src))?;
        }
        drop_op(&lib.conn, op)?;
        return Ok(true);
    }
    let at_dst = present(&lib.root.join(&op.dst));
    // コピーの移動元はライブラリの外のこともあり、残っていて当然なので見ない
    let at_src = !op.copy && present(&lib.root.join(&op.src));
    match (at_src, at_dst) {
        (false, true) => finish(lib, op, apply)?,
        (true, false) => drop_op(&lib.conn, op)?,
        (false, false) if op.copy => drop_op(&lib.conn, op)?,
        _ => return Ok(false),
    }
    Ok(true)
}

/// 起動時に呼ぶ。残っている予定を後始末し、決められなかった予定を返す
pub fn recover(lib: &mut Library, apply: Apply) -> Result<Vec<PendingOp>, String> {
    let ops = {
        let mut stmt = lib
            .conn
            .prepare("SELECT id, kind, target_id, copy, src, dst FROM pending_ops ORDER BY id")
            .map_err(err)?;
        let ops = stmt
            .query_map([], |r| {
                Ok(PendingOp {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    target_id: r.get(2)?,
                    copy: r.get(3)?,
                    src: PathBuf::from(r.get::<_, String>(4)?),
                    dst: PathBuf::from(r.get::<_, String>(5)?),
                })
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        ops
    };
    let mut left = Vec::new();
    for op in ops {
        match settle(lib, &op, apply) {
            Ok(true) => log::info!("途中で止まった操作 {} を後始末しました", op.id),
            Ok(false) => left.push(op),
            Err(e) => {
                log::error!("途中で止まった操作 {} を後始末できません：{e}", op.id);
                left.push(op);
            }
        }
    }
    Ok(left)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::library;

    // KURA_TEST_DIR に exFAT などのボリュームを指定すると、そのファイルシステムで同じテストを流せる
    fn setup() -> (TempDir, Library) {
        let dir = match std::env::var_os("KURA_TEST_DIR") {
            Some(base) => tempfile::tempdir_in(base).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let lib = library::create(dir.path()).unwrap();
        lib.conn
            .execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY, path TEXT NOT NULL)")
            .unwrap();
        for d in ["座り", "立ち"] {
            fs::create_dir(dir.path().join(d)).unwrap();
        }
        (dir, lib)
    }

    fn put(lib: &Library, rel: &str, body: &str) -> i64 {
        fs::write(lib.root.join(rel), body).unwrap();
        lib.conn
            .execute("INSERT INTO items(path) VALUES (?1)", [rel])
            .unwrap();
        lib.conn.last_insert_rowid()
    }

    fn apply(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
        tx.execute(
            "UPDATE items SET path = ?1 WHERE id = ?2",
            params![op.dst.to_str(), op.target_id],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    fn broken_apply(_: &Transaction, _: &PendingOp) -> Result<(), String> {
        Err("DB を更新できません".into())
    }

    fn mv<'a>(
        id: i64,
        src: &'a str,
        dst_dir: &'a str,
        name: &'a str,
        on_conflict: OnConflict,
    ) -> Request<'a> {
        Request {
            kind: "item",
            target_id: Some(id),
            copy: false,
            src: Path::new(src),
            dst_dir: Path::new(dst_dir),
            name,
            on_conflict,
        }
    }

    // ._ は exFAT で macOS が拡張属性を置くファイルなので数えない
    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                e.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .nfc()
                    .collect::<String>()
            })
            .filter(|n| !n.starts_with("._"))
            .collect();
        names.sort();
        names
    }

    fn read(lib: &Library, rel: &str) -> String {
        fs::read_to_string(lib.root.join(rel)).unwrap()
    }

    fn item_path(lib: &Library, id: i64) -> String {
        lib.conn
            .query_row("SELECT path FROM items WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn pending(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn rename_excl_は移動先があれば上書きせずにエラーにする() {
        let (_d, lib) = setup();
        put(&lib, "座り/a.jpg", "A");
        put(&lib, "立ち/a.jpg", "先客");

        assert!(rename_excl(&lib.root.join("座り/a.jpg"), &lib.root.join("立ち/a.jpg")).is_err());

        assert_eq!(read(&lib, "座り/a.jpg"), "A");
        assert_eq!(read(&lib, "立ち/a.jpg"), "先客");
    }

    #[test]
    fn 移動先に同名がなければその名前で移しdbも更新する() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "a.jpg", OnConflict::Number),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("立ち/a.jpg"));
        assert_eq!(entries(&lib.root.join("座り")), Vec::<String>::new());
        assert_eq!(read(&lib, "立ち/a.jpg"), "A");
        assert_eq!(item_path(&lib, id), "立ち/a.jpg");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 同名があれば上書きせず空いている連番を付ける() {
        let (_d, mut lib) = setup();
        put(&lib, "立ち/a.jpg", "先客");
        put(&lib, "立ち/a (2).jpg", "先客2");
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "a.jpg", OnConflict::Number),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("立ち/a (3).jpg"));
        assert_eq!(read(&lib, "立ち/a.jpg"), "先客");
        assert_eq!(read(&lib, "立ち/a (2).jpg"), "先客2");
        assert_eq!(read(&lib, "立ち/a (3).jpg"), "A");
        assert_eq!(item_path(&lib, id), "立ち/a (3).jpg");
    }

    #[test]
    fn 大文字と小文字だけが違う名前も衝突として連番を付ける() {
        let (_d, mut lib) = setup();
        put(&lib, "立ち/A.JPG", "先客");
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "a.jpg", OnConflict::Number),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("立ち/a (2).jpg"));
        assert_eq!(entries(&lib.root.join("立ち")), ["A.JPG", "a (2).jpg"]);
    }

    #[test]
    fn 正規化の形だけが違う名前も衝突として扱う() {
        let (_d, mut lib) = setup();
        let nfd: String = "ポーズ.jpg".nfd().collect();
        fs::write(lib.root.join("立ち").join(&nfd), "先客").unwrap();
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "ポーズ.jpg", OnConflict::Number),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("立ち/ポーズ (2).jpg"));
        assert_eq!(read(&lib, "立ち/ポーズ.jpg"), "先客");
    }

    #[test]
    fn 衝突をエラーにする操作では何も変えない() {
        let (_d, mut lib) = setup();
        put(&lib, "立ち/a.jpg", "先客");
        let id = put(&lib, "座り/a.jpg", "A");

        let err = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "A.jpg", OnConflict::Fail),
            &apply,
        )
        .unwrap_err();

        assert!(err.contains("同じ名前"), "{err}");
        assert_eq!(read(&lib, "座り/a.jpg"), "A");
        assert_eq!(read(&lib, "立ち/a.jpg"), "先客");
        assert_eq!(item_path(&lib, id), "座り/a.jpg");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 大文字と小文字だけの名前変更ができる() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "座り", "A.jpg", OnConflict::Fail),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("座り/A.jpg"));
        assert_eq!(entries(&lib.root.join("座り")), ["A.jpg"]);
        assert_eq!(read(&lib, "座り/A.jpg"), "A");
        assert_eq!(item_path(&lib, id), "座り/A.jpg");
    }

    #[test]
    fn 同じフォルダの中で名前を変えられる() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "座り", "b.jpg", OnConflict::Fail),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("座り/b.jpg"));
        assert_eq!(entries(&lib.root.join("座り")), ["b.jpg"]);
        assert_eq!(item_path(&lib, id), "座り/b.jpg");
    }

    #[test]
    fn 同じ名前への変更は何もしない() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "座り", "a.jpg", OnConflict::Fail),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("座り/a.jpg"));
        assert_eq!(entries(&lib.root.join("座り")), ["a.jpg"]);
    }

    #[test]
    fn フォルダを中身ごと移動して名前を変えられる() {
        let (_d, mut lib) = setup();
        fs::create_dir(lib.root.join("座り/椅子")).unwrap();
        put(&lib, "座り/椅子/a.jpg", "A");

        let dst = transfer(
            &mut lib,
            mv(0, "座り/椅子", "立ち", "壁際", OnConflict::Fail),
            &apply,
        )
        .unwrap();

        assert_eq!(dst, Path::new("立ち/壁際"));
        assert_eq!(read(&lib, "立ち/壁際/a.jpg"), "A");
        assert_eq!(entries(&lib.root.join("座り")), Vec::<String>::new());
    }

    #[test]
    fn コピーは元を残し一時ファイルを残さない() {
        let (_d, mut lib) = setup();
        put(&lib, "立ち/a.jpg", "先客");
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("a.jpg");
        fs::write(&src, "A").unwrap();
        let req = Request {
            copy: true,
            target_id: None,
            ..mv(0, "", "立ち", "a.jpg", OnConflict::Number)
        };

        let dst = transfer(&mut lib, Request { src: &src, ..req }, &|_, _| Ok(())).unwrap();

        assert_eq!(dst, Path::new("立ち/a (2).jpg"));
        assert_eq!(fs::read_to_string(&src).unwrap(), "A");
        assert_eq!(entries(&lib.root.join("立ち")), ["a (2).jpg", "a.jpg"]);
        assert_eq!(read(&lib, "立ち/a (2).jpg"), "A");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn コピーしたファイルは元ファイルの更新日時を引き継ぐ() {
        let (_d, mut lib) = setup();
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("a.jpg");
        fs::write(&src, "A").unwrap();
        // exFAT の更新日時の精度（10ミリ秒）でも同じ値になるよう、秒単位の時刻にする
        let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        let req = Request {
            copy: true,
            target_id: None,
            ..mv(0, "", "立ち", "a.jpg", OnConflict::Number)
        };

        transfer(&mut lib, Request { src: &src, ..req }, &|_, _| Ok(())).unwrap();

        let copied = fs::metadata(lib.root.join("立ち/a.jpg")).unwrap();
        assert_eq!(copied.modified().unwrap(), mtime);
    }

    #[test]
    fn 移動元がなければエラーにして予定を残さない() {
        let (_d, mut lib) = setup();

        let err = transfer(
            &mut lib,
            mv(1, "座り/ない.jpg", "立ち", "ない.jpg", OnConflict::Number),
            &apply,
        )
        .unwrap_err();

        assert!(err.contains("見つかりません"), "{err}");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn dbの更新に失敗したら予定を残し後始末で移動を完了させる() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");

        assert!(transfer(
            &mut lib,
            mv(id, "座り/a.jpg", "立ち", "a.jpg", OnConflict::Number),
            &broken_apply
        )
        .is_err());

        assert_eq!(read(&lib, "立ち/a.jpg"), "A");
        assert_eq!(item_path(&lib, id), "座り/a.jpg");
        assert_eq!(pending(&lib), 1);

        let left = recover(&mut lib, &apply).unwrap();

        assert!(left.is_empty(), "{left:?}");
        assert_eq!(item_path(&lib, id), "立ち/a.jpg");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 予定の記録の後で止まったら後始末で移動を取り消す() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");
        record(
            &lib,
            "item",
            Some(id),
            false,
            Path::new("座り/a.jpg"),
            Path::new("立ち/a.jpg"),
        )
        .unwrap();

        let left = recover(&mut lib, &apply).unwrap();

        assert!(left.is_empty(), "{left:?}");
        assert_eq!(read(&lib, "座り/a.jpg"), "A");
        assert_eq!(entries(&lib.root.join("立ち")), Vec::<String>::new());
        assert_eq!(item_path(&lib, id), "座り/a.jpg");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn コピーの途中で止まったら後始末で一時ファイルを消す() {
        let (_d, mut lib) = setup();
        let op = record(
            &lib,
            "item",
            None,
            true,
            Path::new("/外/a.jpg"),
            Path::new("立ち/a.jpg"),
        )
        .unwrap();
        fs::write(lib.root.join(tmp_path(&op)), "途中まで").unwrap();

        let left = recover(&mut lib, &apply).unwrap();

        assert!(left.is_empty(), "{left:?}");
        assert_eq!(entries(&lib.root.join("立ち")), Vec::<String>::new());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 大文字小文字の名前変更が一時的な名前で止まったら元の名前に戻す() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");
        let op = record(
            &lib,
            "item",
            Some(id),
            false,
            Path::new("座り/a.jpg"),
            Path::new("座り/A.jpg"),
        )
        .unwrap();
        fs::rename(lib.root.join("座り/a.jpg"), lib.root.join(tmp_path(&op))).unwrap();

        let left = recover(&mut lib, &apply).unwrap();

        assert!(left.is_empty(), "{left:?}");
        assert_eq!(entries(&lib.root.join("座り")), ["a.jpg"]);
        assert_eq!(read(&lib, "座り/a.jpg"), "A");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 移動元にも移動先にもなければ予定を残して知らせる() {
        let (_d, mut lib) = setup();
        record(
            &lib,
            "item",
            Some(1),
            false,
            Path::new("座り/a.jpg"),
            Path::new("立ち/a.jpg"),
        )
        .unwrap();

        let left = recover(&mut lib, &apply).unwrap();

        assert_eq!(left.len(), 1);
        assert_eq!(left[0].dst, Path::new("立ち/a.jpg"));
        assert_eq!(pending(&lib), 1);
    }

    #[test]
    fn 移動元と移動先の両方にあれば予定を残して知らせる() {
        let (_d, mut lib) = setup();
        let id = put(&lib, "座り/a.jpg", "A");
        put(&lib, "立ち/a.jpg", "B");
        record(
            &lib,
            "item",
            Some(id),
            false,
            Path::new("座り/a.jpg"),
            Path::new("立ち/a.jpg"),
        )
        .unwrap();

        let left = recover(&mut lib, &apply).unwrap();

        assert_eq!(left.len(), 1);
        assert_eq!(read(&lib, "座り/a.jpg"), "A");
        assert_eq!(read(&lib, "立ち/a.jpg"), "B");
    }

    #[test]
    fn ライブラリを開くと途中で止まった操作を後始末する() {
        let (dir, lib) = setup();
        put(&lib, "座り/a.jpg", "A");
        record(
            &lib,
            "item",
            Some(1),
            false,
            Path::new("座り/a.jpg"),
            Path::new("立ち/a.jpg"),
        )
        .unwrap();
        drop(lib);

        let lib = library::open(dir.path()).unwrap();

        assert_eq!(pending(&lib), 0);
        assert_eq!(read(&lib, "座り/a.jpg"), "A");
    }
}
