use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::category;
use crate::library::{err, Library};

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
    /// 絞り込み（FR-504）を画面側で行うため、メモとタグの id も一覧に含める
    pub memo: String,
    pub tags: Vec<i64>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub collapsed: bool,
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
    // ゴミ箱の画像（FR-511）と見つからない画像（FR-104）は一覧に出さない
    let images = images(lib, "deleted_at IS NULL AND missing_at IS NULL ORDER BY id")?;
    let categories = conn
        .prepare(
            "SELECT id, name, parent_id, collapsed FROM categories ORDER BY sort_order, name, id",
        )
        .map_err(err)?
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                collapsed: r.get(3)?,
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

/// ゴミ箱の画像（FR-511）。削除した新しい順に並べる
pub fn trash(lib: &Library) -> Result<Vec<Image>, String> {
    images(lib, "deleted_at IS NOT NULL ORDER BY deleted_at DESC, id")
}

/// 差分検出（FR-104）で実ファイルが見つからなかった画像。見つからなくなった新しい順に並べる
pub fn missing(lib: &Library) -> Result<Vec<Image>, String> {
    images(
        lib,
        "deleted_at IS NULL AND missing_at IS NOT NULL ORDER BY missing_at DESC, id",
    )
}

fn images(lib: &Library, filter: &str) -> Result<Vec<Image>, String> {
    let conn = &lib.conn;
    let mut tags_of: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT image_id, tag_id FROM image_tags ORDER BY image_id, tag_id")
        .map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(r) = rows.next().map_err(err)? {
        tags_of
            .entry(r.get(0).map_err(err)?)
            .or_default()
            .push(r.get(1).map_err(err)?);
    }
    let images = conn
        .prepare(&format!(
            "SELECT id, file_name, hash, width, height, color, category_id, rating, imported_at, memo
             FROM images WHERE {filter}"
        ))
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
                memo: r.get(9)?,
                tags: tags_of.remove(&r.get(0)?).unwrap_or_default(),
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(images)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Source {
    pub image_url: Option<String>,
    pub page_url: Option<String>,
    /// ブラウザで開ける URL。有効な掲載ページURLを優先し、なければ画像URL。どちらも開けない値なら None
    pub link: Option<String>,
}

/// 詳細パネル（FR-507）に出すもののうち、一覧の Image に含めていないもの
#[derive(Debug, PartialEq, Serialize)]
pub struct Detail {
    /// 実ファイルの絶対パス。拡大表示（FR-508）で元の画像を読む
    pub path: PathBuf,
    pub file_size: i64,
    pub source: Option<Source>,
}

pub fn detail(lib: &Library, id: i64) -> Result<Detail, String> {
    let conn = &lib.conn;
    let (file_name, category_id, file_size) = conn
        .query_row(
            "SELECT file_name, category_id, file_size FROM images
             WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or(format!("画像が見つかりません（{id}）"))?;
    let source = conn
        .query_row(
            "SELECT image_url, page_url FROM image_sources WHERE image_id = ?1",
            [id],
            |r| {
                let (image_url, page_url): (Option<String>, Option<String>) =
                    (r.get(0)?, r.get(1)?);
                Ok(Source {
                    link: crate::source::link(image_url.as_deref(), page_url.as_deref()),
                    image_url,
                    page_url,
                })
            },
        )
        .optional()
        .map_err(err)?;
    Ok(Detail {
        path: lib
            .root
            .join(category::dir(lib, category_id)?)
            .join(file_name),
        file_size,
        source,
    })
}

// ゴミ箱の画像は画面に出ないので、書き換えない
fn update(lib: &Library, id: i64, column: &str, value: &dyn rusqlite::ToSql) -> Result<(), String> {
    let changed = lib
        .conn
        .execute(
            &format!("UPDATE images SET {column} = ?1 WHERE id = ?2 AND deleted_at IS NULL"),
            rusqlite::params![value, id],
        )
        .map_err(err)?;
    match changed {
        0 => Err(format!("画像が見つかりません（{id}）")),
        _ => Ok(()),
    }
}

/// メモを保存する（FR-411）
pub fn set_memo(lib: &Library, id: i64, memo: &str) -> Result<(), String> {
    update(lib, id, "memo", &memo)
}

/// 評価を保存する（FR-411）。0 は評価なし
pub fn set_rating(lib: &Library, id: i64, rating: i64) -> Result<(), String> {
    if !(0..=5).contains(&rating) {
        return Err(format!("評価は0〜5で指定してください（{rating}）"));
    }
    update(lib, id, "rating", &rating)
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
            .execute_batch(&format!(
                "INSERT INTO tags(name) VALUES ('振り返り'), ('座り');
                 INSERT INTO image_tags VALUES ({a}, 2), ({a}, 1);
                 UPDATE images SET memo = '腕の角度' WHERE id = {a};"
            ))
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
                memo: "腕の角度".into(),
                tags: vec![1, 2],
            }
        );
        assert_eq!(g.images[1].tags, Vec::<i64>::new());
        assert_eq!(
            g.categories,
            [
                Category {
                    id: pose,
                    name: "ポーズ".into(),
                    parent_id: None,
                    collapsed: false,
                },
                Category {
                    id: sit,
                    name: "座り".into(),
                    parent_id: Some(pose),
                    collapsed: false,
                },
            ]
        );
        assert_eq!(
            g.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["座り", "振り返り"]
        );
    }

    #[test]
    fn 詳細は実ファイルのパスとファイルサイズと元urlを返す() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = library::create(dir.path()).unwrap();
        let pose = category::create(&mut lib, None, "ポーズ").unwrap();
        let sit = category::create(&mut lib, Some(pose), "座り").unwrap();
        let a = insert_image(&lib, "a.jpg", Some(sit), false);
        lib.conn
            .execute_batch(&format!(
                "INSERT INTO image_sources VALUES ({a}, 'https://example.com/a.jpg', 'https://example.com/', 5)"
            ))
            .unwrap();

        let d = detail(&lib, a).unwrap();

        assert_eq!(
            d,
            Detail {
                path: dir.path().join("ポーズ/座り/a.jpg"),
                file_size: 1,
                source: Some(Source {
                    image_url: Some("https://example.com/a.jpg".into()),
                    page_url: Some("https://example.com/".into()),
                    link: Some("https://example.com/".into()),
                }),
            }
        );
    }

    #[test]
    fn 詳細の開くurlは掲載ページurlが開けない値なら画像urlにしどちらも開けなければ出さない() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let a = insert_image(&lib, "a.jpg", None, false);
        let b = insert_image(&lib, "b.jpg", None, false);
        lib.conn
            .execute_batch(&format!(
                "INSERT INTO image_sources VALUES ({a}, 'https://example.com/a.jpg', 'file:///etc/hosts', 5);
                 INSERT INTO image_sources VALUES ({b}, 'javascript:alert(1)', NULL, 5)"
            ))
            .unwrap();

        let link = |id| detail(&lib, id).unwrap().source.unwrap().link;
        assert_eq!(link(a).as_deref(), Some("https://example.com/a.jpg"));
        assert_eq!(link(b), None);
    }

    #[test]
    fn 未分類の画像の詳細は未分類のフォルダのパスで元urlはない() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let a = insert_image(&lib, "a.jpg", None, false);

        let d = detail(&lib, a).unwrap();

        assert_eq!(d.path, dir.path().join("_未分類/a.jpg"));
        assert_eq!(d.source, None);
    }

    #[test]
    fn ないかゴミ箱にある画像の詳細はエラーにする() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let trashed = insert_image(&lib, "b.jpg", None, true);

        for id in [trashed, 999] {
            let e = detail(&lib, id).unwrap_err();
            assert!(e.contains("画像が見つかりません"), "{e}");
        }
    }

    #[test]
    fn メモと評価を保存する() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let a = insert_image(&lib, "a.jpg", None, false);
        let b = insert_image(&lib, "b.jpg", None, false);

        set_memo(&lib, a, "腕の角度\n肩の線").unwrap();
        set_rating(&lib, a, 5).unwrap();
        set_rating(&lib, b, 0).unwrap();

        let images = load(&lib).unwrap().images;
        assert_eq!(images[0].memo, "腕の角度\n肩の線");
        let ratings: Vec<i64> = images.iter().map(|i| i.rating).collect();
        assert_eq!(ratings, [5, 0], "b の評価3を0（評価なし）にした");
    }

    #[test]
    fn 評価が0から5の外ならエラーにして変えない() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let a = insert_image(&lib, "a.jpg", None, false);

        for rating in [-1, 6] {
            let e = set_rating(&lib, a, rating).unwrap_err();
            assert!(e.contains("評価は0〜5"), "{e}");
        }
        assert_eq!(load(&lib).unwrap().images[0].rating, 3);
    }

    #[test]
    fn ないかゴミ箱にある画像のメモと評価はエラーにして変えない() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();
        let trashed = insert_image(&lib, "b.jpg", None, true);

        for id in [trashed, 999] {
            assert!(set_memo(&lib, id, "x")
                .unwrap_err()
                .contains("画像が見つかりません"));
            assert!(set_rating(&lib, id, 1)
                .unwrap_err()
                .contains("画像が見つかりません"));
        }
        let (memo, rating): (String, i64) = lib
            .conn
            .query_row(
                "SELECT memo, rating FROM images WHERE id = ?1",
                [trashed],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((memo.as_str(), rating), ("", 3));
    }

    #[test]
    fn 空のライブラリでは空の一覧を返す() {
        let dir = tempfile::tempdir().unwrap();
        let lib = library::create(dir.path()).unwrap();

        let g = load(&lib).unwrap();

        assert!(g.images.is_empty() && g.categories.is_empty() && g.tags.is_empty());
    }
}
