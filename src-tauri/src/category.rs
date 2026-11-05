use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::fileops::{self, OnConflict, PendingOp, Request};
use crate::library::{Library, TRASH_DIR, UNCATEGORIZED_DIR};

/// 画像をカテゴリのフォルダへ移す操作の、pending_ops の種類
pub const MOVE_IMAGE: &str = "move_image";

fn err(e: impl Display) -> String {
    e.to_string()
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Moved {
    pub id: i64,
    /// 移した後のファイル名。移動先に同名があれば連番が付く
    pub file_name: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Failed {
    pub id: i64,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Assigned {
    pub moved: Vec<Moved>,
    pub failed: Vec<Failed>,
}

/// ids の画像のカテゴリを category（None は未分類）にし、ファイルをそのフォルダへ移す（FR-402、FR-407）。
/// 1枚ずつ移し、移せない画像はファイルも DB も元のまま failed に入れて、残りを続ける
pub fn assign(lib: &mut Library, ids: &[i64], category: Option<i64>) -> Result<Assigned, String> {
    let dst_dir = dir(lib, category)?;
    let mut out = Assigned::default();
    for &id in ids {
        match move_image(lib, id, &dst_dir) {
            Ok(file_name) => out.moved.push(Moved { id, file_name }),
            Err(message) => out.failed.push(Failed { id, message }),
        }
    }
    Ok(out)
}

fn move_image(lib: &mut Library, id: i64, dst_dir: &Path) -> Result<String, String> {
    let (src_dir, file_name) = locate(lib, id)?;
    transfer_image(
        lib,
        id,
        &src_dir.join(&file_name),
        dst_dir,
        &file_name,
        OnConflict::Number,
    )
}

/// 画像のファイル名を変える（FR-410）。拡張子は元のまま残し、stem は拡張子より前の部分。
/// 同じフォルダに同名があればエラーにする。返り値は変えた後のファイル名
pub fn rename_image(lib: &mut Library, id: i64, stem: &str) -> Result<String, String> {
    check_name("ファイル名", stem)?;
    let (dir, file_name) = locate(lib, id)?;
    let name = match fileops::split_ext(&file_name) {
        (_, "") => stem.to_string(),
        (_, ext) => format!("{stem}.{ext}"),
    };
    transfer_image(lib, id, &dir.join(file_name), &dir, &name, OnConflict::Fail)
}

/// ゴミ箱にない画像の、フォルダ（ライブラリからの相対パス）とファイル名
pub(crate) fn locate(lib: &Library, id: i64) -> Result<(PathBuf, String), String> {
    let (file_name, category): (String, Option<i64>) = lib
        .conn
        .query_row(
            "SELECT file_name, category_id FROM images WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or(format!("画像が見つかりません（{id}）"))?;
    Ok((dir(lib, category)?, file_name))
}

fn transfer_image(
    lib: &mut Library,
    id: i64,
    src: &Path,
    dst_dir: &Path,
    name: &str,
    on_conflict: OnConflict,
) -> Result<String, String> {
    let dst = fileops::transfer(
        lib,
        Request {
            kind: MOVE_IMAGE,
            target_id: Some(id),
            copy: false,
            src,
            dst_dir,
            name,
            on_conflict,
        },
        &apply_move,
    )?;
    Ok(dst.file_name().unwrap().to_string_lossy().into_owned())
}

/// MOVE_IMAGE の DB の更新。カテゴリとファイル名を移動先のパスから決める。
/// 起動時の後始末でも同じ関数を使うので、予定に残したパスだけを手がかりにする
pub fn apply_move(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    let (Some(parent), Some(name)) = (op.dst.parent(), op.dst.file_name().and_then(|n| n.to_str()))
    else {
        return Err(format!("移動先を扱えません（{}）", op.dst.display()));
    };
    let changed = tx
        .execute(
            "UPDATE images SET category_id = ?1, file_name = ?2 WHERE id = ?3",
            params![by_dir(tx, parent)?, name, op.target_id],
        )
        .map_err(err)?;
    match changed {
        0 => Err(format!("画像が見つかりません（{:?}）", op.target_id)),
        _ => Ok(()),
    }
}

/// dir の逆。フォルダ（ライブラリからの相対パス）に当たるカテゴリ
fn by_dir(conn: &Connection, path: &Path) -> Result<Option<i64>, String> {
    if path == Path::new(UNCATEGORIZED_DIR) {
        return Ok(None);
    }
    let mut id = None;
    for name in path.iter() {
        id = conn
            .query_row(
                "SELECT id FROM categories WHERE parent_id IS ?1 AND name = ?2",
                params![id, name.to_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if id.is_none() {
            return Err(format!("カテゴリが見つかりません（{}）", path.display()));
        }
    }
    Ok(id)
}

/// カテゴリのフォルダ（ライブラリからの相対パス）。None は未分類
pub fn dir(lib: &Library, id: Option<i64>) -> Result<PathBuf, String> {
    let Some(id) = id else {
        return Ok(PathBuf::from(UNCATEGORIZED_DIR));
    };
    let mut stmt = lib
        .conn
        .prepare(
            "WITH RECURSIVE chain(name, parent_id, depth) AS (
                SELECT name, parent_id, 0 FROM categories WHERE id = ?1
                UNION ALL
                SELECT c.name, c.parent_id, chain.depth + 1
                FROM categories c JOIN chain ON c.id = chain.parent_id
            )
            SELECT name FROM chain ORDER BY depth DESC",
        )
        .map_err(err)?;
    let names = stmt
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<PathBuf, _>>()
        .map_err(err)?;
    if names.as_os_str().is_empty() {
        return Err(format!("カテゴリが見つかりません（{id}）"));
    }
    Ok(names)
}

/// カテゴリ名とファイル名に共通の検査。what は「カテゴリ名」などの呼び名
fn check_name(what: &str, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{what}を入力してください"));
    }
    if name.contains(['/', ':']) {
        return Err(format!("{what}に / と : は使えません"));
    }
    // .kura もここで弾かれる。. で始まる画像は Finder でも差分検出（FR-104）でも見えなくなる
    if name.starts_with('.') {
        return Err(format!("{what}を . で始めることはできません"));
    }
    Ok(())
}

pub(crate) fn validate(name: &str) -> Result<(), String> {
    check_name("カテゴリ名", name)?;
    if name == UNCATEGORIZED_DIR {
        return Err(format!("{UNCATEGORIZED_DIR} はカテゴリ名に使えません"));
    }
    Ok(())
}

/// parent の下（None はルート直下）にカテゴリを作り、フォルダも作る。返り値は新しいカテゴリの id
pub fn create(lib: &mut Library, parent: Option<i64>, name: &str) -> Result<i64, String> {
    let name: String = name.nfc().collect();
    validate(&name)?;
    let parent_dir = match parent {
        Some(_) => lib.root.join(dir(lib, parent)?),
        None => lib.root.clone(),
    };
    fileops::free_name(&parent_dir, &name, None, OnConflict::Fail)?;
    let path = parent_dir.join(&name);

    // 行を足してからフォルダを作り、最後にコミットする。フォルダを作れなければ行は取り消される。
    // コミット前に止まるとフォルダだけが残るが、差分検出（FR-104）が新しいフォルダとして登録する
    let tx = lib.conn.transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO categories(name, parent_id) VALUES (?1, ?2)",
        params![name, parent],
    )
    .map_err(err)?;
    let id = tx.last_insert_rowid();
    fs::create_dir(&path)
        .map_err(|e| format!("フォルダを作れません（{}、{e}）", path.display()))?;
    if let Err(e) = tx.commit() {
        let _ = fs::remove_dir(&path);
        return Err(err(e));
    }
    Ok(id)
}

/// カテゴリのフォルダの名前を変える・移す操作の、pending_ops の種類
pub const MOVE_CATEGORY: &str = "move_category";

/// サイドバーでカテゴリを閉じる・開く（FR-503）。ファイルは動かさない
pub fn set_collapsed(lib: &Library, ids: &[i64], collapsed: bool) -> Result<(), String> {
    let mut stmt = lib
        .conn
        .prepare("UPDATE categories SET collapsed = ?1 WHERE id = ?2")
        .map_err(|e| e.to_string())?;
    for id in ids {
        stmt.execute(rusqlite::params![collapsed, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// カテゴリ名を変え、フォルダ名も変える（FR-403）。同じ場所に同名があればエラーにする
pub fn rename(lib: &mut Library, id: i64, name: &str) -> Result<(), String> {
    let name: String = name.nfc().collect();
    validate(&name)?;
    let src = dir(lib, Some(id))?;
    let parent = src.parent().unwrap_or(Path::new("")).to_path_buf();
    transfer_category(lib, id, &src, &parent, &name)
}

/// カテゴリを parent の下（None はルート直下）へ移し、フォルダも移す（FR-412）
pub fn move_to(lib: &mut Library, id: i64, parent: Option<i64>) -> Result<(), String> {
    let src = dir(lib, Some(id))?;
    let dst_dir = match parent {
        Some(_) => dir(lib, parent)?,
        None => PathBuf::new(),
    };
    // フォルダは1対1なので、パスの包含で子孫を判定できる
    if dst_dir.starts_with(&src) {
        return Err("カテゴリを自分自身や子孫の下へは移せません".into());
    }
    let name = src.file_name().unwrap().to_string_lossy().into_owned();
    transfer_category(lib, id, &src, &dst_dir, &name)
}

fn transfer_category(
    lib: &mut Library,
    id: i64,
    src: &Path,
    dst_dir: &Path,
    name: &str,
) -> Result<(), String> {
    fileops::transfer(
        lib,
        Request {
            kind: MOVE_CATEGORY,
            target_id: Some(id),
            copy: false,
            src,
            dst_dir,
            name,
            on_conflict: OnConflict::Fail,
        },
        &apply_category,
    )
    .map(|_| ())
}

/// MOVE_CATEGORY の DB の更新。名前と親を移動先のパスから決める。配下のカテゴリと画像の行はパスを持たないので変えない
pub fn apply_category(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    let (Some(parent), Some(name)) = (op.dst.parent(), op.dst.file_name().and_then(|n| n.to_str()))
    else {
        return Err(format!("移動先を扱えません（{}）", op.dst.display()));
    };
    let changed = tx
        .execute(
            "UPDATE categories SET name = ?1, parent_id = ?2 WHERE id = ?3",
            params![name, by_dir(tx, parent)?, op.target_id],
        )
        .map_err(err)?;
    match changed {
        0 => Err(format!("カテゴリが見つかりません（{:?}）", op.target_id)),
        _ => Ok(()),
    }
}

/// カテゴリのフォルダをゴミ箱へ移す操作の、pending_ops の種類
pub const TRASH_CATEGORY: &str = "trash_category";

// ?1 のカテゴリと、その子孫のカテゴリ
pub(crate) const SUBTREE: &str = "WITH RECURSIVE sub(id) AS (
    SELECT ?1 UNION ALL SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
)";

#[derive(Debug, Default, Serialize)]
pub struct Deleted {
    /// 未分類へ移した画像
    pub moved: Vec<Moved>,
    pub failed: Vec<Failed>,
    /// カテゴリを消せなかった理由。None ならカテゴリは子カテゴリごと消えた
    pub error: Option<String>,
}

/// カテゴリを子カテゴリごと削除する（FR-404）。配下の画像を未分類へ移してから、フォルダを .kura/trash/ へ移し、
/// 移した先で .DS_Store だけか空のフォルダを消す。管理外のファイルが残ったフォルダはゴミ箱に残る。
/// 移せない画像が1枚でもあれば、カテゴリもフォルダも消さない
pub fn delete(lib: &mut Library, id: i64) -> Result<Deleted, String> {
    let src = dir(lib, Some(id))?;
    let ids = {
        let mut stmt = lib
            .conn
            .prepare(&format!(
                "{SUBTREE} SELECT id FROM images
                 WHERE deleted_at IS NULL AND category_id IN sub ORDER BY id"
            ))
            .map_err(err)?;
        let ids = stmt
            .query_map([id], |r| r.get::<_, i64>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        ids
    };
    let Assigned { moved, failed } = assign(lib, &ids, None)?;
    let mut out = Deleted {
        moved,
        failed,
        error: None,
    };
    if !out.failed.is_empty() {
        out.error = Some("未分類へ移せない画像があるので、カテゴリを削除しませんでした".into());
        return Ok(out);
    }

    // 空のフォルダも含めてまとめてゴミ箱へ移し、カテゴリの行の削除と1つの操作にする。
    // ライブラリの中で先にフォルダを消していくと、途中で失敗したときにフォルダのないカテゴリが残るため
    let trash = Path::new(TRASH_DIR);
    let name = src.file_name().unwrap().to_string_lossy().into_owned();
    let result = fs::create_dir_all(lib.root.join(trash))
        .map_err(|e| format!("ゴミ箱のフォルダを作れません（{e}）"))
        .and_then(|_| {
            fileops::transfer(
                lib,
                Request {
                    kind: TRASH_CATEGORY,
                    target_id: Some(id),
                    copy: false,
                    src: &src,
                    dst_dir: trash,
                    name: &name,
                    on_conflict: OnConflict::Number,
                },
                &apply_trash,
            )
        });
    match result {
        Ok(dst) => {
            if let Err(e) = prune(&lib.root.join(&dst)) {
                log::warn!("ゴミ箱の空のフォルダを消せません（{}、{e}）", dst.display());
            }
        }
        Err(e) => out.error = Some(e),
    }
    Ok(out)
}

/// TRASH_CATEGORY の DB の更新。カテゴリを子孫ごと消す。ゴミ箱の画像は category_id を空にし、
/// 復元（FR-511）で元のカテゴリが消えたと分かるよう category_deleted に印を付ける。
/// 未分類へ移していない画像が残っていれば、外部キーの制約で失敗する
pub fn apply_trash(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE images SET category_id = NULL, category_deleted = 1
             WHERE deleted_at IS NOT NULL AND category_id IN sub"
        ),
        [op.target_id],
    )
    .map_err(err)?;
    tx.execute(
        &format!("{SUBTREE} DELETE FROM categories WHERE id IN sub"),
        [op.target_id],
    )
    .map(|_| ())
    .map_err(err)
}

/// .DS_Store だけか空のフォルダを、深い方から消す。管理外のファイルが残るフォルダは消さない。返り値は path を消したか
fn prune(path: &Path) -> std::io::Result<bool> {
    let mut keep = false;
    for e in fs::read_dir(path)? {
        let e = e?;
        // シンボリックリンクはたどらず、管理外のファイルとして残す
        if e.file_type()?.is_dir() {
            keep |= !prune(&e.path())?;
        } else {
            keep |= e.file_name() != ".DS_Store";
        }
    }
    if keep {
        return Ok(false);
    }
    match fs::remove_file(path.join(".DS_Store")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    fs::remove_dir(path)?;
    Ok(true)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;
    use crate::library::{self, UNCATEGORIZED_DIR};

    // fileops のテストと同じく、KURA_TEST_DIR に exFAT などのボリュームを指定できる
    pub(crate) fn setup() -> (TempDir, Library) {
        let dir = match std::env::var_os("KURA_TEST_DIR") {
            Some(base) => tempfile::tempdir_in(base).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let lib = library::create(dir.path()).unwrap();
        (dir, lib)
    }

    /// 書き込めないフォルダにして、失敗を起こす。exFAT と FAT32 は Unix の権限を持たず書き込めてしまうので、
    /// そのときは元に戻して false を返し、テストはそこで終える（失敗時の巻き戻しはファイルシステムに依らないため）
    pub(crate) fn lock(dir: &Path) -> bool {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
        let probe = dir.join(".kura-probe");
        if fs::create_dir(&probe).is_err() {
            return true;
        }
        fs::remove_dir(&probe).unwrap();
        unlock(dir);
        eprintln!("skip: {} は権限で書き込みを止められない", dir.display());
        false
    }

    pub(crate) fn unlock(dir: &Path) {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn count(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM categories", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn 閉じたカテゴリは開き直しても閉じたまま() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let dress = create(&mut lib, None, "服飾").unwrap();
        let bg = create(&mut lib, None, "背景").unwrap();

        set_collapsed(&lib, &[pose, dress], true).unwrap();
        set_collapsed(&lib, &[dress], false).unwrap();
        drop(lib);
        let lib = library::open(d.path()).unwrap();

        let collapsed = |id| {
            crate::gallery::load(&lib)
                .unwrap()
                .categories
                .into_iter()
                .find(|c| c.id == id)
                .unwrap()
                .collapsed
        };
        assert!(collapsed(pose));
        assert!(!collapsed(dress));
        assert!(!collapsed(bg));
    }

    #[test]
    fn ルート直下にカテゴリを作るとフォルダができる() {
        let (_d, mut lib) = setup();

        let id = create(&mut lib, None, "ポーズ").unwrap();

        assert!(lib.root.join("ポーズ").is_dir());
        assert_eq!(dir(&lib, Some(id)).unwrap(), Path::new("ポーズ"));
    }

    #[test]
    fn カテゴリの下に入れ子のカテゴリを作れる() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();

        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let chair = create(&mut lib, Some(sit), "椅子").unwrap();

        assert!(lib.root.join("ポーズ/座り/椅子").is_dir());
        assert_eq!(
            dir(&lib, Some(chair)).unwrap(),
            Path::new("ポーズ/座り/椅子")
        );
    }

    #[test]
    fn 未分類のフォルダはルート直下の専用フォルダ() {
        let (_d, lib) = setup();
        assert_eq!(dir(&lib, None).unwrap(), Path::new(UNCATEGORIZED_DIR));
    }

    #[test]
    fn 使えない名前はエラーにしてフォルダもカテゴリも作らない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();

        for name in ["", "a/b", "a:b", ".隠し", ".kura", "_未分類"] {
            assert!(create(&mut lib, None, name).is_err(), "{name:?}");
            assert!(create(&mut lib, Some(pose), name).is_err(), "{name:?}");
        }

        assert_eq!(count(&lib), 1);
        assert_eq!(files(&lib, ""), [".kura", "_未分類", "ポーズ"]);
        assert_eq!(fs::read_dir(lib.root.join("ポーズ")).unwrap().count(), 0);
    }

    #[test]
    fn 同じ場所に同名のカテゴリは作れない() {
        let (_d, mut lib) = setup();
        create(&mut lib, None, "Pose").unwrap();

        // 大文字・小文字と正規化（NFD の「ポ」）の違いは同名とみなす
        for name in ["Pose", "POSE"] {
            let err = create(&mut lib, None, name).err().unwrap();
            assert!(err.contains("同じ名前"), "{err}");
        }
        create(&mut lib, None, "ポーズ").unwrap();
        assert!(create(&mut lib, None, "ホ\u{309a}ーズ").is_err());
        assert_eq!(count(&lib), 2);
    }

    #[test]
    fn 別の親の下なら同じ名前のカテゴリを作れる() {
        let (_d, mut lib) = setup();
        let a = create(&mut lib, None, "女性").unwrap();
        let b = create(&mut lib, None, "男性").unwrap();

        create(&mut lib, Some(a), "座り").unwrap();
        create(&mut lib, Some(b), "座り").unwrap();

        assert!(lib.root.join("女性/座り").is_dir());
        assert!(lib.root.join("男性/座り").is_dir());
    }

    #[test]
    fn finderで作った同名のフォルダやファイルがあればエラーにする() {
        let (_d, mut lib) = setup();
        fs::create_dir(lib.root.join("服飾")).unwrap();
        fs::write(lib.root.join("メモ"), b"").unwrap();

        assert!(create(&mut lib, None, "服飾").is_err());
        assert!(create(&mut lib, None, "メモ").is_err());
        assert_eq!(count(&lib), 0);
    }

    #[test]
    fn 存在しない親カテゴリの下には作れない() {
        let (_d, mut lib) = setup();
        assert!(create(&mut lib, Some(999), "座り").is_err());
        assert_eq!(count(&lib), 0);
    }

    #[test]
    fn フォルダを作れなければカテゴリも残さない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        // 読めるが書き込めない親フォルダ。名前の検査は通り、フォルダの作成で失敗する
        let parent = lib.root.join("ポーズ");
        if !lock(&parent) {
            return;
        }

        let result = create(&mut lib, Some(pose), "座り");

        unlock(&parent);
        assert!(result.err().unwrap().contains("フォルダを作れません"));
        assert_eq!(count(&lib), 1);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }

    /// category のフォルダに中身 body のファイルを置き、画像として登録する
    pub(crate) fn put(lib: &Library, category: Option<i64>, name: &str, body: &str) -> i64 {
        fs::write(lib.root.join(dir(lib, category).unwrap()).join(name), body).unwrap();
        lib.conn
            .execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    category_id, imported_at, registered_at)
                 VALUES (?1, ?2, 1, 1, 1, 1, '#808080', ?3, 1, 1)",
                params![name, body, category],
            )
            .unwrap();
        lib.conn.last_insert_rowid()
    }

    pub(crate) fn row(lib: &Library, id: i64) -> (String, Option<i64>) {
        lib.conn
            .query_row(
                "SELECT file_name, category_id FROM images WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    pub(crate) fn read(lib: &Library, rel: &str) -> String {
        fs::read_to_string(lib.root.join(rel)).unwrap()
    }

    pub(crate) fn pending(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))
            .unwrap()
    }

    pub(crate) fn files(lib: &Library, rel: &str) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(lib.root.join(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().nfc().collect())
            .collect();
        names.sort();
        names
    }

    fn moved(id: i64, file_name: &str) -> Moved {
        Moved {
            id,
            file_name: file_name.into(),
        }
    }

    #[test]
    fn 複数の画像にカテゴリを設定するとファイルをそのフォルダへ移しdbも変える() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let a = put(&lib, None, "a.jpg", "A");
        let b = put(&lib, Some(pose), "b.png", "B");

        let r = assign(&mut lib, &[a, b], Some(sit)).unwrap();

        assert_eq!(r.moved, [moved(a, "a.jpg"), moved(b, "b.png")]);
        assert!(r.failed.is_empty());
        assert_eq!(files(&lib, "ポーズ/座り"), ["a.jpg", "b.png"]);
        assert_eq!(files(&lib, "_未分類"), Vec::<String>::new());
        assert_eq!(files(&lib, "ポーズ"), ["座り"]);
        assert_eq!(read(&lib, "ポーズ/座り/a.jpg"), "A");
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(sit)));
        assert_eq!(row(&lib, b), ("b.png".into(), Some(sit)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 未分類を設定すると未分類のフォルダへ戻す() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");

        let r = assign(&mut lib, &[a], None).unwrap();

        assert_eq!(r.moved, [moved(a, "a.jpg")]);
        assert_eq!(files(&lib, "_未分類"), ["a.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
    }

    #[test]
    fn 移動先に同名のファイルがあれば連番を付けて移しファイル名も記録する() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let first = put(&lib, Some(pose), "a.jpg", "先客");
        // Finder で置いた、大文字だけが違う管理外のファイルも衝突として数える
        fs::write(lib.root.join("ポーズ/A (2).jpg"), "管理外").unwrap();
        let a = put(&lib, None, "a.jpg", "A");

        let r = assign(&mut lib, &[a], Some(pose)).unwrap();

        assert_eq!(r.moved, [moved(a, "a (3).jpg")]);
        assert_eq!(read(&lib, "ポーズ/a.jpg"), "先客");
        assert_eq!(read(&lib, "ポーズ/A (2).jpg"), "管理外");
        assert_eq!(read(&lib, "ポーズ/a (3).jpg"), "A");
        assert_eq!(row(&lib, a), ("a (3).jpg".into(), Some(pose)));
        assert_eq!(row(&lib, first), ("a.jpg".into(), Some(pose)));
    }

    #[test]
    fn 別のカテゴリの同名の画像をまとめて移すと2枚目に連番を付ける() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, None, "座り").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        let b = put(&lib, Some(sit), "a.jpg", "B");

        let r = assign(&mut lib, &[a, b], None).unwrap();

        assert_eq!(r.moved, [moved(a, "a.jpg"), moved(b, "a (2).jpg")]);
        assert_eq!(read(&lib, "_未分類/a (2).jpg"), "B");
    }

    #[test]
    fn 今と同じカテゴリを設定してもファイルもdbも変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");

        let r = assign(&mut lib, &[a], Some(pose)).unwrap();

        assert_eq!(r.moved, [moved(a, "a.jpg")]);
        assert_eq!(files(&lib, "ポーズ"), ["a.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 途中の画像が移せなくても残りは移し移せない画像のファイルとdbは元のまま() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let locked = create(&mut lib, None, "鍵付き").unwrap();
        let a = put(&lib, None, "a.jpg", "A");
        let gone = put(&lib, None, "gone.jpg", "G");
        fs::remove_file(lib.root.join("_未分類/gone.jpg")).unwrap();
        let stuck = put(&lib, Some(locked), "stuck.jpg", "S");
        let trashed = put(&lib, None, "trashed.jpg", "T");
        lib.conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [trashed])
            .unwrap();
        let c = put(&lib, None, "c.jpg", "C");
        // 書き込めないフォルダからはファイルを出せない（rename が失敗する）
        let locked_dir = lib.root.join("鍵付き");
        if !lock(&locked_dir) {
            return;
        }

        let r = assign(&mut lib, &[a, gone, stuck, trashed, 999, c], Some(pose));

        unlock(&locked_dir);
        let r = r.unwrap();
        assert_eq!(r.moved, [moved(a, "a.jpg"), moved(c, "c.jpg")]);
        let failed: Vec<i64> = r.failed.iter().map(|f| f.id).collect();
        assert_eq!(failed, [gone, stuck, trashed, 999]);
        assert!(
            r.failed[0].message.contains("見つかりません"),
            "{:?}",
            r.failed
        );
        assert_eq!(files(&lib, "ポーズ"), ["a.jpg", "c.jpg"]);
        assert_eq!(files(&lib, "鍵付き"), ["stuck.jpg"]);
        assert_eq!(files(&lib, "_未分類"), ["trashed.jpg"]);
        assert_eq!(row(&lib, gone), ("gone.jpg".into(), None));
        assert_eq!(row(&lib, stuck), ("stuck.jpg".into(), Some(locked)));
        assert_eq!(row(&lib, trashed), ("trashed.jpg".into(), None));
        assert_eq!(row(&lib, c), ("c.jpg".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ファイル名を変えると実ファイル名とdbが変わり拡張子は元のまま() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");

        // NFD の「ポ」も NFC にそろえる
        let name = rename_image(&mut lib, a, "ホ\u{309a}ーズ.参考").unwrap();

        assert_eq!(name, "ポーズ.参考.jpg");
        assert_eq!(files(&lib, "ポーズ"), ["ポーズ.参考.jpg"]);
        assert_eq!(read(&lib, "ポーズ/ポーズ.参考.jpg"), "A");
        assert_eq!(row(&lib, a), ("ポーズ.参考.jpg".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 大文字と小文字だけのファイル名の変更ができる() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.JPG", "A");

        assert_eq!(rename_image(&mut lib, a, "A").unwrap(), "A.JPG");

        assert_eq!(files(&lib, "_未分類"), ["A.JPG"]);
        assert_eq!(row(&lib, a), ("A.JPG".into(), None));
    }

    #[test]
    fn 同じフォルダに同名のファイルがあればエラーにして何も変えない() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        put(&lib, None, "b.jpg", "B");
        // Finder で置いた管理外のファイルも、大文字・小文字を無視して衝突として数える
        fs::write(lib.root.join("_未分類/C.jpg"), "管理外").unwrap();

        for stem in ["b", "B", "c"] {
            let err = rename_image(&mut lib, a, stem).err().unwrap();
            assert!(err.contains("同じ名前"), "{err}");
        }

        assert_eq!(files(&lib, "_未分類"), ["C.jpg", "a.jpg", "b.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 使えないファイル名とゴミ箱の画像はエラーにして何も変えない() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        let trashed = put(&lib, None, "t.jpg", "T");
        lib.conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [trashed])
            .unwrap();

        for stem in ["", "x/y", "x:y", ".隠し"] {
            assert!(rename_image(&mut lib, a, stem).is_err(), "{stem:?}");
        }
        assert!(rename_image(&mut lib, trashed, "u").is_err());
        assert!(rename_image(&mut lib, 999, "u").is_err());

        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "t.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        assert_eq!(row(&lib, trashed), ("t.jpg".into(), None));
    }

    #[test]
    fn ファイル名を変えられなければファイルもdbも元のまま() {
        let (_d, mut lib) = setup();
        let locked = create(&mut lib, None, "鍵付き").unwrap();
        let a = put(&lib, Some(locked), "a.jpg", "A");
        // 書き込めないフォルダの中では rename が失敗する
        let locked_dir = lib.root.join("鍵付き");
        if !lock(&locked_dir) {
            return;
        }

        let r = rename_image(&mut lib, a, "b");

        unlock(&locked_dir);
        assert!(r.is_err());
        assert_eq!(files(&lib, "鍵付き"), ["a.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(locked)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ないカテゴリを設定するとエラーにして何も移さない() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");

        assert!(assign(&mut lib, &[a], Some(999)).is_err());

        assert_eq!(files(&lib, "_未分類"), ["a.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
    }

    #[test]
    fn 移したあとdbを更新する前に止まった移動は起動時にdbを移動先に合わせる() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let a = put(&lib, None, "a.jpg", "A");
        // 予定の記録と rename までを済ませ、DB の更新の前に止まった状態を作る
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst)
                 VALUES (?1, ?2, 0, '_未分類/a.jpg', 'ポーズ/座り/a (2).jpg')",
                params![MOVE_IMAGE, a],
            )
            .unwrap();
        fs::rename(
            lib.root.join("_未分類/a.jpg"),
            lib.root.join("ポーズ/座り/a (2).jpg"),
        )
        .unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(row(&lib, a), ("a (2).jpg".into(), Some(sit)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 親のフォルダがfinderで消されていたらエラーにする() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        fs::remove_dir(lib.root.join("ポーズ")).unwrap();

        assert!(create(&mut lib, Some(pose), "座り").is_err());

        assert_eq!(count(&lib), 1);
        assert!(!lib.root.join("ポーズ").exists());
    }

    fn cat(lib: &Library, id: i64) -> (String, Option<i64>) {
        lib.conn
            .query_row(
                "SELECT name, parent_id FROM categories WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    // ._ は exFAT で macOS が拡張属性を置くファイルなので数えない
    fn top(lib: &Library) -> Vec<String> {
        files(lib, "")
            .into_iter()
            .filter(|n| !n.starts_with("._"))
            .collect()
    }

    #[test]
    fn カテゴリ名を変えるとフォルダ名も変わり配下の画像の行は変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let a = put(&lib, Some(sit), "a.jpg", "A");

        rename(&mut lib, pose, "人物").unwrap();

        assert_eq!(top(&lib), [".kura", "_未分類", "人物"]);
        assert_eq!(read(&lib, "人物/座り/a.jpg"), "A");
        assert_eq!(cat(&lib, pose), ("人物".into(), None));
        assert_eq!(dir(&lib, Some(sit)).unwrap(), Path::new("人物/座り"));
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(sit)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 入れ子のカテゴリの名前も変えられる() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();

        rename(&mut lib, sit, "しゃがみ").unwrap();

        assert_eq!(files(&lib, "ポーズ"), ["しゃがみ"]);
        assert_eq!(cat(&lib, sit), ("しゃがみ".into(), Some(pose)));
    }

    #[test]
    fn 大文字と小文字だけの名前変更もできる() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "pose").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");

        rename(&mut lib, pose, "Pose").unwrap();

        assert_eq!(top(&lib), [".kura", "Pose", "_未分類"]);
        assert_eq!(read(&lib, "Pose/a.jpg"), "A");
        assert_eq!(cat(&lib, pose), ("Pose".into(), None));
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 同じ名前への変更は何もしない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();

        // NFD の「ポ」も同じ名前
        rename(&mut lib, pose, "ホ\u{309a}ーズ").unwrap();

        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 名前変更の先に同名のカテゴリやfinderのフォルダがあればエラーにして何も変えない() {
        let (_d, mut lib) = setup();
        create(&mut lib, None, "Pose").unwrap();
        create(&mut lib, None, "ポーズ").unwrap();
        fs::create_dir(lib.root.join("服飾")).unwrap();
        let other = create(&mut lib, None, "背景").unwrap();

        for name in ["Pose", "POSE", "ホ\u{309a}ーズ", "服飾"] {
            let e = rename(&mut lib, other, name).err().unwrap();
            assert!(e.contains("同じ名前"), "{name:?} {e}");
        }

        assert_eq!(cat(&lib, other), ("背景".into(), None));
        assert_eq!(
            top(&lib),
            [".kura", "Pose", "_未分類", "ポーズ", "服飾", "背景"]
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 使えない名前には変えられない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();

        for name in ["", "a/b", "a:b", ".隠し", ".kura", "_未分類"] {
            assert!(rename(&mut lib, pose, name).is_err(), "{name:?}");
        }

        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(top(&lib), [".kura", "_未分類", "ポーズ"]);
    }

    #[test]
    fn フォルダがfinderで消されていたら名前を変えずにエラーにする() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        fs::remove_dir(lib.root.join("ポーズ")).unwrap();

        assert!(rename(&mut lib, pose, "人物").is_err());

        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダ名を変えられなければカテゴリ名も変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        // 書き込めない親フォルダの中では rename が失敗する
        let parent = lib.root.join("ポーズ");
        if !lock(&parent) {
            return;
        }

        let result = rename(&mut lib, sit, "しゃがみ");

        unlock(&parent);
        assert!(result.is_err());
        assert_eq!(files(&lib, "ポーズ"), ["座り"]);
        assert_eq!(cat(&lib, sit), ("座り".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ないカテゴリの名前は変えられない() {
        let (_d, mut lib) = setup();
        assert!(rename(&mut lib, 999, "人物").is_err());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn カテゴリを別のカテゴリの下へ移すとフォルダも移り配下の画像の行は変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let chair = create(&mut lib, Some(sit), "椅子").unwrap();
        let wear = create(&mut lib, None, "服飾").unwrap();
        let a = put(&lib, Some(chair), "a.jpg", "A");

        move_to(&mut lib, sit, Some(wear)).unwrap();

        assert_eq!(files(&lib, "ポーズ"), Vec::<String>::new());
        assert_eq!(read(&lib, "服飾/座り/椅子/a.jpg"), "A");
        assert_eq!(cat(&lib, sit), ("座り".into(), Some(wear)));
        assert_eq!(dir(&lib, Some(chair)).unwrap(), Path::new("服飾/座り/椅子"));
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(chair)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn カテゴリをルート直下へ移せる() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();

        move_to(&mut lib, sit, None).unwrap();

        assert_eq!(top(&lib), [".kura", "_未分類", "ポーズ", "座り"]);
        assert_eq!(cat(&lib, sit), ("座り".into(), None));
    }

    #[test]
    fn 今の親へ移しても何も変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();

        move_to(&mut lib, sit, Some(pose)).unwrap();
        move_to(&mut lib, pose, None).unwrap();

        assert_eq!(cat(&lib, sit), ("座り".into(), Some(pose)));
        assert_eq!(files(&lib, "ポーズ"), ["座り"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 移動先に同名のカテゴリやfinderのフォルダがあればエラーにして何も変えない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "Sit").unwrap();
        let wear = create(&mut lib, None, "服飾").unwrap();
        create(&mut lib, Some(wear), "sit").unwrap();
        fs::create_dir(lib.root.join("Sit")).unwrap();

        for parent in [Some(wear), None] {
            let e = move_to(&mut lib, sit, parent).err().unwrap();
            assert!(e.contains("同じ名前"), "{parent:?} {e}");
        }

        assert_eq!(cat(&lib, sit), ("Sit".into(), Some(pose)));
        assert_eq!(files(&lib, "ポーズ"), ["Sit"]);
        assert_eq!(files(&lib, "服飾"), ["sit"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 自分自身や子孫の下へは移せない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let chair = create(&mut lib, Some(sit), "椅子").unwrap();
        // 名前が前方一致するだけの別のカテゴリの下へは移せる
        let poses = create(&mut lib, None, "ポーズ集").unwrap();

        for parent in [pose, sit, chair] {
            let e = move_to(&mut lib, pose, Some(parent)).err().unwrap();
            assert!(e.contains("子孫"), "{parent} {e}");
        }
        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(files(&lib, "ポーズ/座り"), ["椅子"]);

        move_to(&mut lib, sit, Some(poses)).unwrap();
        assert_eq!(files(&lib, "ポーズ集"), ["座り"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ないカテゴリやないカテゴリの下へは移せない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();

        assert!(move_to(&mut lib, 999, None).is_err());
        assert!(move_to(&mut lib, pose, Some(999)).is_err());

        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダを移せなければカテゴリも移さない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let wear = create(&mut lib, None, "服飾").unwrap();
        let parent = lib.root.join("ポーズ");
        if !lock(&parent) {
            return;
        }

        let result = move_to(&mut lib, sit, Some(wear));

        unlock(&parent);
        assert!(result.is_err());
        assert_eq!(files(&lib, "ポーズ"), ["座り"]);
        assert_eq!(files(&lib, "服飾"), Vec::<String>::new());
        assert_eq!(cat(&lib, sit), ("座り".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダを移したあとdbを更新する前に止まった移動は起動時にdbを移動先に合わせる() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let wear = create(&mut lib, None, "服飾").unwrap();
        // 予定の記録と rename までを済ませ、DB の更新の前に止まった状態を作る（移動と名前変更を同時に）
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst)
                 VALUES (?1, ?2, 0, 'ポーズ/座り', '服飾/しゃがみ')",
                params![MOVE_CATEGORY, sit],
            )
            .unwrap();
        fs::rename(lib.root.join("ポーズ/座り"), lib.root.join("服飾/しゃがみ")).unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(cat(&lib, sit), ("しゃがみ".into(), Some(wear)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダを移す前に止まった名前変更は起動時に予定だけ消す() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst)
                 VALUES (?1, ?2, 0, 'ポーズ', '人物')",
                params![MOVE_CATEGORY, pose],
            )
            .unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(cat(&lib, pose), ("ポーズ".into(), None));
        assert_eq!(top(&lib), [".kura", "_未分類", "ポーズ"]);
        assert_eq!(pending(&lib), 0);
    }

    fn categories(lib: &Library) -> Vec<String> {
        let mut stmt = lib
            .conn
            .prepare("SELECT name FROM categories ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn 子カテゴリごと削除すると画像を未分類へ移しフォルダとカテゴリを消す() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let chair = create(&mut lib, Some(sit), "椅子").unwrap();
        create(&mut lib, None, "服飾").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        let b = put(&lib, Some(chair), "b.png", "B");
        // Finder が作る .DS_Store だけが残るフォルダは消してよい
        fs::write(lib.root.join("ポーズ/座り/.DS_Store"), b"").unwrap();

        let r = delete(&mut lib, pose).unwrap();

        assert_eq!(r.error, None);
        assert_eq!(r.failed, []);
        assert_eq!(r.moved.len(), 2);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        assert_eq!(row(&lib, b), ("b.png".into(), None));
        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "b.png"]);
        assert_eq!(files(&lib, ""), [".kura", "_未分類", "服飾"]);
        assert_eq!(files(&lib, TRASH_DIR), Vec::<String>::new());
        assert_eq!(categories(&lib), ["服飾"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 管理外のファイルが残ったフォルダはゴミ箱へ移す() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        create(&mut lib, Some(pose), "立ち").unwrap();
        let a = put(&lib, Some(sit), "a.jpg", "A");
        fs::write(lib.root.join("ポーズ/座り/メモ.txt"), b"memo").unwrap();
        fs::write(lib.root.join("ポーズ/座り/.DS_Store"), b"").unwrap();
        fs::write(lib.root.join("ポーズ/立ち/.DS_Store"), b"").unwrap();

        let r = delete(&mut lib, pose).unwrap();

        assert_eq!(r.error, None);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        assert_eq!(files(&lib, ""), [".kura", "_未分類"]);
        // 管理外のファイルがあるフォルダは中身ごと残し、.DS_Store だけのフォルダは消す
        assert_eq!(files(&lib, ".kura/trash"), ["ポーズ"]);
        assert_eq!(files(&lib, ".kura/trash/ポーズ"), ["座り"]);
        assert_eq!(
            files(&lib, ".kura/trash/ポーズ/座り"),
            [".DS_Store", "メモ.txt"]
        );
        assert_eq!(categories(&lib), Vec::<String>::new());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 未分類やゴミ箱に同名があれば連番を付ける() {
        let (_d, mut lib) = setup();
        let a = create(&mut lib, None, "女性").unwrap();
        let b = create(&mut lib, None, "男性").unwrap();
        let sit_a = create(&mut lib, Some(a), "座り").unwrap();
        let sit_b = create(&mut lib, Some(b), "座り").unwrap();
        put(&lib, None, "a.jpg", "A1");
        let dup = put(&lib, Some(sit_a), "a.jpg", "A2");
        fs::write(lib.root.join("女性/座り/x.txt"), b"").unwrap();
        fs::write(lib.root.join("男性/座り/y.txt"), b"").unwrap();

        let r1 = delete(&mut lib, sit_a).unwrap();
        let r2 = delete(&mut lib, sit_b).unwrap();

        assert_eq!((r1.error, r2.error), (None, None));
        assert_eq!(r1.moved, [moved(dup, "a (2).jpg")]);
        assert_eq!(files(&lib, "_未分類"), ["a (2).jpg", "a.jpg"]);
        assert_eq!(files(&lib, ".kura/trash"), ["座り", "座り (2)"]);
        assert_eq!(categories(&lib), ["女性", "男性"]);
    }

    #[test]
    fn ゴミ箱の画像は元のカテゴリが消えた印を残す() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let trashed = put(&lib, Some(pose), "t.jpg", "T");
        lib.conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [trashed])
            .unwrap();
        fs::remove_file(lib.root.join("ポーズ/t.jpg")).unwrap();

        let r = delete(&mut lib, pose).unwrap();

        // 復元のとき（FR-511）、元のカテゴリが消えたことを知らせられるように印を残す
        assert_eq!(r.error, None);
        assert_eq!(r.moved, []);
        assert_eq!(row(&lib, trashed), ("t.jpg".into(), None));
        let flag: i64 = lib
            .conn
            .query_row(
                "SELECT category_deleted FROM images WHERE id = ?1",
                [trashed],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, 1);
        assert_eq!(categories(&lib), Vec::<String>::new());
    }

    #[test]
    fn 未分類へ移せない画像があればカテゴリもフォルダも消さない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        let gone = put(&lib, Some(sit), "gone.jpg", "G");
        fs::remove_file(lib.root.join("ポーズ/座り/gone.jpg")).unwrap();

        let r = delete(&mut lib, pose).unwrap();

        assert!(r.error.is_some());
        assert_eq!(r.moved, [moved(a, "a.jpg")]);
        assert_eq!(r.failed.iter().map(|f| f.id).collect::<Vec<_>>(), [gone]);
        assert_eq!(row(&lib, gone), ("gone.jpg".into(), Some(sit)));
        assert_eq!(files(&lib, "ポーズ"), ["座り"]);
        assert_eq!(categories(&lib), ["ポーズ", "座り"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダをゴミ箱へ移せなければカテゴリを消さない() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        let trash = lib.root.join(TRASH_DIR);
        fs::create_dir_all(&trash).unwrap();
        if !lock(&trash) {
            return;
        }

        let r = delete(&mut lib, pose).unwrap();

        unlock(&trash);
        assert!(r.error.is_some());
        // 画像は未分類へ移ったまま。カテゴリとフォルダは残る
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        assert!(lib.root.join("ポーズ").is_dir());
        assert_eq!(categories(&lib), ["ポーズ"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ないカテゴリは削除できない() {
        let (_d, mut lib) = setup();
        assert!(delete(&mut lib, 999).is_err());
    }

    #[test]
    fn フォルダをゴミ箱へ移したあとdbを更新する前に止まった削除は起動時にカテゴリを消す() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        create(&mut lib, Some(pose), "座り").unwrap();
        create(&mut lib, None, "服飾").unwrap();
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst)
                 VALUES (?1, ?2, 0, 'ポーズ', '.kura/trash/ポーズ')",
                params![TRASH_CATEGORY, pose],
            )
            .unwrap();
        fs::create_dir_all(lib.root.join(TRASH_DIR)).unwrap();
        fs::rename(lib.root.join("ポーズ"), lib.root.join(".kura/trash/ポーズ")).unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(categories(&lib), ["服飾"]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn フォルダをゴミ箱へ移す前に止まった削除は起動時に予定だけ消す() {
        let (d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst)
                 VALUES (?1, ?2, 0, 'ポーズ', '.kura/trash/ポーズ')",
                params![TRASH_CATEGORY, pose],
            )
            .unwrap();
        drop(lib);

        let lib = library::open(d.path()).unwrap();

        assert_eq!(categories(&lib), ["ポーズ"]);
        assert!(lib.root.join("ポーズ").is_dir());
        assert_eq!(pending(&lib), 0);
    }
}
