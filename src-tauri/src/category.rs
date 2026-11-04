use std::fmt::Display;
use std::fs;
use std::path::PathBuf;

use rusqlite::params;
use unicode_normalization::UnicodeNormalization;

use crate::fileops::{self, OnConflict};
use crate::library::{Library, UNCATEGORIZED_DIR};

fn err(e: impl Display) -> String {
    e.to_string()
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
