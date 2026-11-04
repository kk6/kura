use std::fmt::Display;

use rusqlite::{params, Connection};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::fileops;
use crate::gallery::Tag;
use crate::library::Library;

fn err(e: impl Display) -> String {
    e.to_string()
}

/// 選んだ画像に付いているタグと、そのタグが付いている枚数（FR-406、FR-407）
#[derive(Debug, PartialEq, Serialize)]
pub struct Counted {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

// SQL の IN に id の列を1つのパラメーターで渡すため、JSON の配列にして json_each で開く
fn json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap()
}

/// name のタグ（なければ作る）を、ids の画像のうちゴミ箱にないものに付ける。
/// 名前は前後の空白を除き、正規化（NFC）と大文字・小文字の違いを無視して既存のタグと同じか判定する
pub fn add(lib: &mut Library, ids: &[i64], name: &str) -> Result<Tag, String> {
    let name: String = name.trim().nfc().collect();
    if name.is_empty() {
        return Err("タグ名を入力してください".into());
    }
    if ids.is_empty() {
        return Err("画像を選んでください".into());
    }
    let tx = lib.conn.transaction().map_err(err)?;
    let tag = match find(&tx, &name)? {
        Some(tag) => tag,
        None => {
            tx.execute("INSERT INTO tags(name) VALUES (?1)", [&name])
                .map_err(err)?;
            Tag {
                id: tx.last_insert_rowid(),
                name,
            }
        }
    };
    tx.execute(
        "INSERT OR IGNORE INTO image_tags(image_id, tag_id)
         SELECT id, ?2 FROM images WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL",
        params![json(ids), tag.id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(tag)
}

fn find(conn: &Connection, name: &str) -> Result<Option<Tag>, String> {
    let key = fileops::key(name.as_ref());
    // shortcut: タグを全件読んで比べる。SQLite の lower() は ASCII しか変えないため。数千件を超えて遅くなったら、比べるための鍵の列と一意の索引を足す
    let tags: Vec<Tag> = conn
        .prepare("SELECT id, name FROM tags")
        .map_err(err)?
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(tags
        .into_iter()
        .find(|t| fileops::key(t.name.as_ref()) == key))
}

/// ids の画像から tag_id のタグを外す。どの画像にも付いていないタグも残す（削除はタグ管理 FR-408）
pub fn remove(lib: &Library, ids: &[i64], tag_id: i64) -> Result<(), String> {
    lib.conn
        .execute(
            "DELETE FROM image_tags WHERE tag_id = ?2 AND image_id IN (SELECT value FROM json_each(?1))",
            params![json(ids), tag_id],
        )
        .map(|_| ())
        .map_err(err)
}

/// ids の画像に付いているタグを名前順に返す
pub fn of(lib: &Library, ids: &[i64]) -> Result<Vec<Counted>, String> {
    lib.conn
        .prepare(
            "SELECT t.id, t.name, count(*) FROM tags t JOIN image_tags it ON it.tag_id = t.id
             WHERE it.image_id IN (SELECT value FROM json_each(?1))
             GROUP BY t.id ORDER BY t.name, t.id",
        )
        .map_err(err)?
        .query_map([json(ids)], |r| {
            Ok(Counted {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
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

    fn image(lib: &Library, name: &str) -> i64 {
        lib.conn
            .execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    imported_at, registered_at)
                 VALUES (?1, ?1, 1, 1, 1, 1, '#808080', 1, 1)",
                [name],
            )
            .unwrap();
        lib.conn.last_insert_rowid()
    }

    fn names(lib: &Library, id: i64) -> Vec<String> {
        of(lib, &[id])
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect()
    }

    fn tag_count(lib: &Library) -> i64 {
        lib.conn
            .query_row("SELECT count(*) FROM tags", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn 新しい名前のタグを複数の画像に付けるとタグを作って全部に付ける() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let b = image(&lib, "b");
        let c = image(&lib, "c");

        let tag = add(&mut lib, &[a, b], "あおり").unwrap();

        assert_eq!(tag.name, "あおり");
        assert_eq!(names(&lib, a), ["あおり"]);
        assert_eq!(names(&lib, b), ["あおり"]);
        assert_eq!(names(&lib, c), Vec::<String>::new());
        assert_eq!(tag_count(&lib), 1);
    }

    #[test]
    fn 正規化と大文字小文字だけが違う名前は既存のタグを付ける() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let pose = add(&mut lib, &[a], "Pose").unwrap();
        let kana = add(&mut lib, &[a], "ポーズ").unwrap();

        for (name, want) in [
            ("pose", &pose),
            (" POSE ", &pose),
            ("ホ\u{309a}ーズ", &kana),
        ] {
            assert_eq!(add(&mut lib, &[a], name).unwrap(), *want, "{name:?}");
        }

        assert_eq!(tag_count(&lib), 2);
        assert_eq!(
            names(&lib, a),
            ["Pose", "ポーズ"],
            "最初に付けたときの書き方のまま"
        );
    }

    #[test]
    fn 前後の空白は除き空の名前はエラーにしてタグを作らない() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");

        assert_eq!(add(&mut lib, &[a], "  座り\u{3000}").unwrap().name, "座り");
        for name in ["", "  ", "\u{3000}"] {
            assert!(add(&mut lib, &[a], name).is_err(), "{name:?}");
        }
        assert!(add(&mut lib, &[], "立ち").is_err(), "画像を選んでいない");
        assert_eq!(tag_count(&lib), 1);
    }

    #[test]
    fn すでに付いている画像を含めて付けても重複しない() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let b = image(&lib, "b");
        add(&mut lib, &[a], "座り").unwrap();

        add(&mut lib, &[a, b], "座り").unwrap();

        assert_eq!(
            of(&lib, &[a, b]).unwrap(),
            [Counted {
                id: 1,
                name: "座り".into(),
                count: 2
            }]
        );
    }

    #[test]
    fn ゴミ箱の画像とない画像には付けず残りには付ける() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let trashed = image(&lib, "t");
        lib.conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [trashed])
            .unwrap();

        add(&mut lib, &[trashed, 999, a], "座り").unwrap();

        assert_eq!(names(&lib, a), ["座り"]);
        assert_eq!(names(&lib, trashed), Vec::<String>::new());
        let rows: i64 = lib
            .conn
            .query_row("SELECT count(*) FROM image_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn 選んだ画像からだけタグを外しタグ自体は残す() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let b = image(&lib, "b");
        let c = image(&lib, "c");
        let sit = add(&mut lib, &[a, b, c], "座り").unwrap();
        add(&mut lib, &[a], "あおり").unwrap();

        remove(&lib, &[a, b], sit.id).unwrap();

        assert_eq!(names(&lib, a), ["あおり"]);
        assert_eq!(names(&lib, b), Vec::<String>::new());
        assert_eq!(names(&lib, c), ["座り"]);
        assert_eq!(tag_count(&lib), 2);
    }

    #[test]
    fn 選んだ画像のタグを名前順に付いている枚数と一緒に返す() {
        let (_d, mut lib) = setup();
        let a = image(&lib, "a");
        let b = image(&lib, "b");
        let other = image(&lib, "other");
        add(&mut lib, &[a, b, other], "振り返り").unwrap();
        add(&mut lib, &[a], "あおり").unwrap();
        add(&mut lib, &[other], "立ち").unwrap();

        let tags: Vec<(String, i64)> = of(&lib, &[a, b])
            .unwrap()
            .into_iter()
            .map(|t| (t.name, t.count))
            .collect();

        assert_eq!(tags, [("あおり".into(), 1), ("振り返り".into(), 2)]);
        assert!(of(&lib, &[]).unwrap().is_empty());
    }
}
