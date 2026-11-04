use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::fileops::{self, OnConflict, PendingOp, Request};
use crate::library::{Library, UNCATEGORIZED_DIR};

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
    let (file_name, current): (String, Option<i64>) = lib
        .conn
        .query_row(
            "SELECT file_name, category_id FROM images WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or(format!("画像が見つかりません（{id}）"))?;
    let src = dir(lib, current)?.join(&file_name);
    let dst = fileops::transfer(
        lib,
        Request {
            kind: MOVE_IMAGE,
            target_id: Some(id),
            copy: false,
            src: &src,
            dst_dir,
            name: &file_name,
            on_conflict: OnConflict::Number,
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

fn validate(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("カテゴリ名を入力してください".into());
    }
    if name.contains(['/', ':']) {
        return Err("カテゴリ名に / と : は使えません".into());
    }
    // .kura もここで弾かれる
    if name.starts_with('.') {
        return Err("カテゴリ名を . で始めることはできません".into());
    }
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use tempfile::TempDir;

    use super::*;
    use crate::library::{self, UNCATEGORIZED_DIR};

    fn setup() -> (TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        (dir, lib)
    }

    fn count(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM categories", [], |r| r.get(0))
            .unwrap()
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
        let mut names: Vec<_> = fs::read_dir(&lib.root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, [".kura", "_未分類", "ポーズ"]);
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
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();

        let result = create(&mut lib, Some(pose), "座り");

        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.err().unwrap().contains("フォルダを作れません"));
        assert_eq!(count(&lib), 1);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }

    /// category のフォルダに中身 body のファイルを置き、画像として登録する
    fn put(lib: &Library, category: Option<i64>, name: &str, body: &str) -> i64 {
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

    fn row(lib: &Library, id: i64) -> (String, Option<i64>) {
        lib.conn
            .query_row(
                "SELECT file_name, category_id FROM images WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    fn read(lib: &Library, rel: &str) -> String {
        fs::read_to_string(lib.root.join(rel)).unwrap()
    }

    fn pending(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))
            .unwrap()
    }

    fn files(lib: &Library, rel: &str) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(lib.root.join(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
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
        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let r = assign(&mut lib, &[a, gone, stuck, trashed, 999, c], Some(pose));

        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o755)).unwrap();
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
}
