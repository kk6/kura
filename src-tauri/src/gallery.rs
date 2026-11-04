use std::fmt::Display;

use serde::Serialize;

use crate::library::Library;

fn err(e: impl Display) -> String {
    e.to_string()
}

/// 一覧に並べる画像1枚分。並べ替え（FR-506）は画面側で行うので、それに要る項目も含める
#[derive(Debug, PartialEq, Serialize)]
pub struct Image {
    pub id: i64,
    pub file_name: String,
    pub hash: String,
    pub width: i64,
    pub height: i64,
    pub color: String,
    pub category_id: Option<i64>,
    pub rating: i64,
    pub imported_at: i64,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
}

/// ギャラリー画面の一覧とサイドバーに出すもの（FR-501、FR-503）
#[derive(Debug, Serialize)]
pub struct Gallery {
    pub images: Vec<Image>,
    pub categories: Vec<Category>,
    pub tags: Vec<Tag>,
}

pub fn load(lib: &Library) -> Result<Gallery, String> {
    let conn = &lib.conn;
    // ゴミ箱の画像は一覧に出さない（FR-511）
    let images = conn
        .prepare(
            "SELECT id, file_name, hash, width, height, color, category_id, rating, imported_at
             FROM images WHERE deleted_at IS NULL ORDER BY id",
        )
        .map_err(err)?
        .query_map([], |r| {
            Ok(Image {
                id: r.get(0)?,
                file_name: r.get(1)?,
                hash: r.get(2)?,
                width: r.get(3)?,
                height: r.get(4)?,
                color: r.get(5)?,
                category_id: r.get(6)?,
                rating: r.get(7)?,
                imported_at: r.get(8)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let categories = conn
        .prepare("SELECT id, name, parent_id FROM categories ORDER BY sort_order, name, id")
        .map_err(err)?
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let tags = conn
        .prepare("SELECT id, name FROM tags ORDER BY name, id")
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
    Ok(Gallery {
        images,
        categories,
        tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{category, library};

    fn insert_image(lib: &Library, name: &str, category_id: Option<i64>, deleted: bool) -> i64 {
        lib.conn
            .execute(
                "INSERT INTO images(file_name, hash, width, height, file_size, file_mtime, color,
                                    category_id, rating, imported_at, registered_at, deleted_at)
                 VALUES (?1, ?1, 320, 480, 1, 1, '#808080', ?2, 3, 1000, 2000, ?3)",
                rusqlite::params![name, category_id, deleted.then_some(3000)],
            )
            .unwrap();
        lib.conn.last_insert_rowid()
    }

    #[test]
    fn ゴミ箱の画像を除いた画像とカテゴリとタグを返す() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = library::create(dir.path()).unwrap();
        let pose = category::create(&mut lib, None, "ポーズ").unwrap();
        let sit = category::create(&mut lib, Some(pose), "座り").unwrap();
        let a = insert_image(&lib, "a.jpg", Some(sit), false);
        insert_image(&lib, "b.jpg", None, true);
        let c = insert_image(&lib, "c.jpg", None, false);
        lib.conn
            .execute_batch("INSERT INTO tags(name) VALUES ('振り返り'), ('座り')")
            .unwrap();

        let g = load(&lib).unwrap();

        assert_eq!(
            g.images.iter().map(|i| i.id).collect::<Vec<_>>(),
            [a, c],
            "ゴミ箱の b.jpg は出さない"
        );
        assert_eq!(
            g.images[0],
            Image {
                id: a,
                file_name: "a.jpg".into(),
                hash: "a.jpg".into(),
                width: 320,
                height: 480,
                color: "#808080".into(),
                category_id: Some(sit),
                rating: 3,
                imported_at: 1000,
            }
        );
        assert_eq!(
            g.categories,
            [
                Category {
                    id: pose,
                    name: "ポーズ".into(),
                    parent_id: None
                },
                Category {
                    id: sit,
                    name: "座り".into(),
                    parent_id: Some(pose)
                },
            ]
        );
        assert_eq!(
            g.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["座り", "振り返り"]
        );
    }

    #[test]
    fn 空のライブラリでは空の一覧を返す() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();

        let g = load(&lib).unwrap();

        assert!(g.images.is_empty() && g.categories.is_empty() && g.tags.is_empty());
    }
}
