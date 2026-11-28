use std::ffi::OsStr;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::fileops;
use crate::library::{err, Library};

/// スマートフォルダ（FR-510）。filter は画面の絞り込みの状態の JSON
#[derive(Debug, PartialEq, Serialize)]
pub struct SmartFolder {
    pub id: i64,
    pub name: String,
    pub filter: String,
}

/// 名前の順（タグと同じ）
pub fn list(lib: &Library) -> Result<Vec<SmartFolder>, String> {
    lib.conn
        .prepare("SELECT id, name, filter FROM smart_folders ORDER BY name, id")
        .map_err(err)?
        .query_map([], |r| {
            Ok(SmartFolder {
                id: r.get(0)?,
                name: r.get(1)?,
                filter: r.get(2)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
}

pub fn create(lib: &Library, name: &str, filter: &str) -> Result<SmartFolder, String> {
    let (name, key) = name_of(name)?;
    object(filter)?;
    unique(&lib.conn, &key, None)?;
    lib.conn
        .execute(
            "INSERT INTO smart_folders(name, name_key, filter) VALUES (?1, ?2, ?3)",
            params![name, key, filter],
        )
        .map_err(err)?;
    Ok(SmartFolder {
        id: lib.conn.last_insert_rowid(),
        name,
        filter: filter.into(),
    })
}

/// 大文字・小文字だけの変更はできる
pub fn rename(lib: &Library, id: i64, name: &str) -> Result<SmartFolder, String> {
    let (name, key) = name_of(name)?;
    unique(&lib.conn, &key, Some(id))?;
    let filter = lib
        .conn
        .query_row(
            "UPDATE smart_folders SET name = ?1, name_key = ?2 WHERE id = ?3 RETURNING filter",
            params![name, key, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| missing(id))?;
    Ok(SmartFolder { id, name, filter })
}

/// 条件だけを消す。画像は変わらない
pub fn delete(lib: &Library, id: i64) -> Result<(), String> {
    match lib
        .conn
        .execute("DELETE FROM smart_folders WHERE id = ?1", [id])
        .map_err(err)?
    {
        0 => Err(missing(id)),
        _ => Ok(()),
    }
}

fn missing(id: i64) -> String {
    format!("スマートフォルダが見つかりません（{id}）")
}

// 名前の扱いはボードと同じ：前後の空白を除き、正規化（NFC）と大文字・小文字の違いを無視して同じ名前か判定する
fn name_of(name: &str) -> Result<(String, String), String> {
    let name: String = name.trim().nfc().collect();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(
            "スマートフォルダの名前は前後の空白を除いて1〜100文字で入力してください".into(),
        );
    }
    let key = fileops::key(OsStr::new(&name));
    Ok((name, key))
}

fn unique(conn: &Connection, key: &str, except: Option<i64>) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM smart_folders WHERE name_key = ?1 AND (?2 IS NULL OR id != ?2))",
            params![key, except],
            |r| r.get(0),
        )
        .map_err(err)?;
    if exists {
        return Err("同じ名前のスマートフォルダがあります".into());
    }
    Ok(())
}

// 画面が読めない値を残さないよう、JSON のオブジェクトだけを受ける
fn object(filter: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(filter)
        .map(|_| ())
        .map_err(|e| format!("絞り込みの条件を読めません（{e}）"))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::library;

    fn setup() -> (TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        (dir, lib)
    }

    fn names(lib: &Library) -> Vec<String> {
        list(lib).unwrap().into_iter().map(|f| f.name).collect()
    }

    #[test]
    fn 保存した条件は名前の順に一覧に出て開き直しても残る() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let b = create(&lib, "座り", r#"{"tags":[1]}"#).unwrap();
        create(&lib, "あおり", r#"{"text":"手"}"#).unwrap();
        assert_eq!(b.name, "座り");
        drop(lib);

        let lib = library::open(dir.path()).unwrap();
        assert_eq!(names(&lib), ["あおり", "座り"]);
        assert_eq!(list(&lib).unwrap()[1].filter, r#"{"tags":[1]}"#);
    }

    #[test]
    fn 名前は前後の空白を除き空と同じ名前とjsonのオブジェクトでない条件はエラーにして保存しない() {
        let (_d, lib) = setup();
        assert_eq!(create(&lib, "  手 ", "{}").unwrap().name, "手");

        assert!(create(&lib, " ", "{}").is_err());
        let e = create(&lib, "手", "{}").unwrap_err();
        assert!(e.contains("同じ名前"), "{e}");
        assert!(create(&lib, "足", "[1]").is_err());
        assert!(create(&lib, "足", "{").is_err());
        assert_eq!(names(&lib), ["手"]);
    }

    #[test]
    fn 名前を変えても条件は残り大文字小文字だけの変更はできるがほかと同じ名前と空とない行はエラー()
    {
        let (_d, lib) = setup();
        let pose = create(&lib, "pose", r#"{"mode":"or"}"#).unwrap();
        create(&lib, "座り", "{}").unwrap();

        let renamed = rename(&lib, pose.id, "Pose").unwrap();
        assert_eq!(renamed.name, "Pose");
        assert_eq!(renamed.filter, r#"{"mode":"or"}"#);
        assert!(rename(&lib, pose.id, "座り")
            .unwrap_err()
            .contains("同じ名前"));
        assert!(rename(&lib, pose.id, "").is_err());
        assert!(rename(&lib, 999, "立ち").is_err());
        assert_eq!(names(&lib), ["Pose", "座り"]);
    }

    #[test]
    fn 削除すると一覧から消え画像は変わらずない行はエラー() {
        let (_d, lib) = setup();
        lib.conn
            .execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    imported_at, registered_at)
                 VALUES ('a', 'a', 1, 1, 1, 1, '#808080', 1, 1)",
                [],
            )
            .unwrap();
        let f = create(&lib, "手", "{}").unwrap();

        delete(&lib, f.id).unwrap();
        assert!(names(&lib).is_empty());
        assert!(delete(&lib, f.id).is_err());
        let images: i64 = lib
            .conn
            .query_row("SELECT count(*) FROM images", [], |r| r.get(0))
            .unwrap();
        assert_eq!(images, 1);
    }
}
