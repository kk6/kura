use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::category::{self, Failed, SUBTREE};
use crate::fileops;
use crate::import::{self, millis, Reason, Skipped};
use crate::library::{Library, KURA_DIR, UNCATEGORIZED_DIR};
use crate::trash::{self, Done};

fn err(e: impl Display) -> String {
    e.to_string()
}

fn nfc(name: &std::ffi::OsStr) -> String {
    name.to_string_lossy().nfc().collect()
}

/// 差分検出（FR-104）の結果
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Report {
    /// 新しいファイルとして登録した枚数
    pub added: usize,
    /// 見つからない画像と同じハッシュのファイルが別の場所にあったので、移動とみなした枚数
    pub moved: usize,
    /// 同じ場所で中身が変わったので、行を更新した枚数
    pub updated: usize,
    /// 新しく「見つからない」状態にした枚数
    pub missing: usize,
    /// 見つからなかったファイルが元の場所に戻った枚数
    pub returned: usize,
    pub categories_added: usize,
    pub categories_removed: usize,
    pub skipped: Vec<Skipped>,
}

/// ライブラリの中にあったファイル。dir と name は NFC にそろえたライブラリからの相対パス
struct Found {
    dir: PathBuf,
    name: String,
    /// 実際のパス。exFAT と FAT32 では名前が NFD のことがある
    path: PathBuf,
    size: i64,
    mtime: i64,
}

#[derive(Default)]
struct Walk {
    /// カテゴリのフォルダ。親が子より先に並ぶ
    dirs: Vec<PathBuf>,
    files: Vec<Found>,
    /// 読めなかったフォルダ。この下のカテゴリと画像は変えない
    unreadable: Vec<PathBuf>,
    skipped: Vec<Skipped>,
}

impl Walk {
    fn fail(&mut self, path: PathBuf, message: String) {
        self.skipped.push(Skipped {
            path,
            reason: Reason::Error { message },
        });
    }

    fn under_unreadable(&self, path: &Path) -> bool {
        self.unreadable.iter().any(|u| path.starts_with(u))
    }

    /// root の下の rel を見る。subdirs が false なら、フォルダを登録せずに知らせる（未分類の下）
    fn visit(&mut self, root: &Path, rel: &Path, subdirs: bool) {
        let abs = root.join(rel);
        let entries = match fs::read_dir(&abs).and_then(|e| e.collect::<Result<Vec<_>, _>>()) {
            Ok(e) => e,
            Err(e) => {
                self.unreadable.push(rel.to_path_buf());
                return self.fail(abs, format!("フォルダを読めません（{e}）"));
            }
        };
        let mut entries: Vec<_> = entries
            .into_iter()
            .map(|e| (nfc(&e.file_name()), e))
            .filter(|(name, _)| !name.starts_with('.'))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, entry) in entries {
            let path = entry.path();
            // file_type はシンボリックリンクをたどらない
            let meta = match entry.file_type().and_then(|t| Ok((t, entry.metadata()?))) {
                Ok(m) => m,
                Err(e) => {
                    self.fail(path, e.to_string());
                    continue;
                }
            };
            let child = rel.join(&name);
            if meta.0.is_dir() {
                if rel.as_os_str().is_empty() && name == UNCATEGORIZED_DIR {
                    self.visit(root, &child, false);
                } else if !subdirs {
                    self.fail(path, "未分類の下のフォルダは登録しません".into());
                } else if let Err(message) = category::validate(&name) {
                    self.fail(path, message);
                } else {
                    self.dirs.push(child.clone());
                    self.visit(root, &child, true);
                }
            } else if meta.0.is_file() {
                if rel.as_os_str().is_empty() {
                    self.fail(
                        path,
                        "ライブラリの直下の画像は登録しません。カテゴリか未分類のフォルダに入れてください".into(),
                    );
                    continue;
                }
                let mtime = match meta.1.modified().map_err(err).and_then(millis) {
                    Ok(m) => m,
                    Err(message) => {
                        self.fail(path, message);
                        continue;
                    }
                };
                self.files.push(Found {
                    dir: rel.to_path_buf(),
                    name,
                    path,
                    size: meta.1.len() as i64,
                    mtime,
                });
            }
        }
    }
}

struct Row {
    id: i64,
    path: PathBuf,
    hash: String,
    size: i64,
    mtime: i64,
    missing: bool,
}

/// DB と実際のファイルの差分を検出して反映する（FR-104）。ファイルは動かさず、DB とサムネイルだけを書き換える。
/// 途中で止まっても、もう一度流せば続きから同じ状態にそろう
// shortcut: 終わるまでライブラリのロックを持つので、新しいファイルが多いと他の操作を待たせる。困ったら取り込みと同じく1枚ごとにロックを外す
pub fn scan(lib: &mut Library) -> Result<Report, String> {
    let mut walk = Walk::default();
    walk.visit(&lib.root, Path::new(""), true);
    if walk.unreadable.iter().any(|u| u.as_os_str().is_empty()) {
        return Err(errors_of(&walk));
    }
    let mut report = Report::default();

    // 1. フォルダをカテゴリに対応させ、新しいフォルダを登録する
    let mut cats: Vec<(i64, String, Option<i64>)> = lib
        .conn
        .prepare("SELECT id, name, parent_id FROM categories ORDER BY id")
        .map_err(err)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut by_dir: HashMap<PathBuf, i64> = HashMap::new();
    let mut matched: HashSet<i64> = HashSet::new();
    for dir in &walk.dirs {
        let parent = match dir.parent() {
            Some(p) if !p.as_os_str().is_empty() => Some(by_dir[p]),
            _ => None,
        };
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let free = |c: &&(i64, String, Option<i64>)| c.2 == parent && !matched.contains(&c.0);
        // 大文字・小文字だけの違いは同じフォルダとみなす。Finder で名前の大文字・小文字だけを変えられるため
        let hit = cats
            .iter()
            .filter(free)
            .find(|c| c.1 == name)
            .or_else(|| {
                let key = fileops::key(name.as_ref());
                cats.iter()
                    .filter(free)
                    .find(|c| fileops::key(c.1.as_ref()) == key)
            })
            .map(|c| (c.0, c.1 != name));
        let id = match hit {
            Some((id, renamed)) => {
                if renamed {
                    lib.conn
                        .execute(
                            "UPDATE categories SET name = ?1 WHERE id = ?2",
                            params![name, id],
                        )
                        .map_err(err)?;
                }
                id
            }
            None => {
                lib.conn
                    .execute(
                        "INSERT INTO categories(name, parent_id) VALUES (?1, ?2)",
                        params![name, parent],
                    )
                    .map_err(err)?;
                report.categories_added += 1;
                let id = lib.conn.last_insert_rowid();
                cats.push((id, name, parent));
                id
            }
        };
        matched.insert(id);
        by_dir.insert(dir.clone(), id);
    }
    by_dir.insert(PathBuf::from(UNCATEGORIZED_DIR), -1);
    let category_of = |dir: &Path| Some(by_dir[dir]).filter(|&id| id >= 0);

    // 2. 画像の行と実際のファイルを、パスで突き合わせる
    let mut dirs: HashMap<Option<i64>, PathBuf> = HashMap::new();
    for c in std::iter::once(None).chain(cats.iter().map(|c| Some(c.0))) {
        dirs.insert(c, category::dir(lib, c)?);
    }
    let rows: Vec<Row> = lib
        .conn
        .prepare(
            "SELECT id, category_id, file_name, hash, file_size, file_mtime, missing_at IS NOT NULL
             FROM images WHERE deleted_at IS NULL ORDER BY id",
        )
        .map_err(err)?
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, String>(2)?,
                Row {
                    id: r.get(0)?,
                    path: PathBuf::new(),
                    hash: r.get(3)?,
                    size: r.get(4)?,
                    mtime: r.get(5)?,
                    missing: r.get(6)?,
                },
            ))
        })
        .map_err(err)?
        .map(|r| {
            r.map(|(_, category, name, mut row)| {
                row.path = dirs[&category].join(name);
                row
            })
        })
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut files: HashMap<PathBuf, Found> = walk
        .files
        .drain(..)
        .map(|f| (f.dir.join(&f.name), f))
        .collect();
    // 実ファイルが見つからなかった行。ハッシュで移動先を探す
    let mut gone: HashMap<String, &Row> = HashMap::new();
    for row in &rows {
        let Some(f) = files.remove(&row.path) else {
            if !walk.under_unreadable(&row.path) {
                gone.insert(row.hash.clone(), row);
            }
            continue;
        };
        // 更新日時は同じボリュームで読んだ値どうしなので、exFAT や FAT32 の粗い刻みでも変わらなければ一致する
        if f.size == row.size && f.mtime == row.mtime {
            if row.missing {
                set_found(lib, row.id, &f, None)?;
                report.returned += 1;
            }
            continue;
        }
        let bytes = match fs::read(&f.path) {
            Ok(b) => b,
            Err(e) => {
                walk.fail(
                    f.path.clone(),
                    format!("{} を読めません（{e}）", f.path.display()),
                );
                continue;
            }
        };
        let hash = import::sha256(&bytes);
        if hash == row.hash {
            set_found(lib, row.id, &f, None)?;
            report.returned += row.missing as usize;
            continue;
        }
        // 同じ場所で中身が変わった（B）。別の画像と同じ中身なら更新せず、古い行を見つからないにする
        if let Some(existing) = owner(lib, &hash)? {
            gone.insert(row.hash.clone(), row);
            walk.skipped.push(Skipped {
                path: f.path,
                reason: Reason::Duplicate { existing },
            });
            continue;
        }
        let Some(format) = import::supported(&bytes) else {
            gone.insert(row.hash.clone(), row);
            walk.skipped.push(Skipped {
                path: f.path,
                reason: Reason::Unsupported,
            });
            continue;
        };
        match import::render(&lib.root, &bytes, format, &hash, &f.path) {
            Ok(r) => {
                lib.conn
                    .execute(
                        "UPDATE images SET hash = ?1, width = ?2, height = ?3, color = ?4,
                                file_size = ?5, file_mtime = ?6, missing_at = NULL WHERE id = ?7",
                        params![hash, r.width, r.height, r.color, f.size, f.mtime, row.id],
                    )
                    .map_err(err)?;
                remove_thumb(&lib.root, &row.hash);
                report.updated += 1;
            }
            Err(message) => walk.fail(f.path, message),
        }
    }

    // 3. どの行にも当たらなかったファイル。移動か、新しい画像
    let mut news: Vec<Found> = files.into_values().collect();
    news.sort_by(|a, b| a.path.cmp(&b.path));
    for f in news {
        let bytes = match fs::read(&f.path) {
            Ok(b) => b,
            Err(e) => {
                walk.fail(
                    f.path.clone(),
                    format!("{} を読めません（{e}）", f.path.display()),
                );
                continue;
            }
        };
        let Some(format) = import::supported(&bytes) else {
            walk.skipped.push(Skipped {
                path: f.path,
                reason: Reason::Unsupported,
            });
            continue;
        };
        let hash = import::sha256(&bytes);
        let category = category_of(&f.dir);
        if let Some(row) = gone.remove(&hash) {
            set_found(lib, row.id, &f, Some(category))?;
            report.moved += 1;
            continue;
        }
        if let Some(existing) = owner(lib, &hash)? {
            walk.skipped.push(Skipped {
                path: f.path,
                reason: Reason::Duplicate { existing },
            });
            continue;
        }
        let added = import::render(&lib.root, &bytes, format, &hash, &f.path).and_then(|r| {
            // 取り込み日時は、ローカルから取り込んだ画像と同じく元ファイルの更新日時
            import::insert(
                &lib.conn, &f.name, &hash, &r, f.size, f.mtime, category, f.mtime,
            )
        });
        match added {
            Ok(_) => report.added += 1,
            Err(message) => walk.fail(f.path, message),
        }
    }

    // 4. 残った行を見つからないにする。タグやメモを失わないよう、行は消さない
    let now = millis(SystemTime::now())?;
    for row in gone.values() {
        report.missing += lib
            .conn
            .execute(
                "UPDATE images SET missing_at = ?1 WHERE id = ?2 AND missing_at IS NULL",
                params![now, row.id],
            )
            .map_err(err)?;
    }

    // 5. フォルダがなくなったカテゴリ（A）を子孫ごと消す。NotFound のときだけ消し、読めないだけのフォルダは残す
    for (id, _, _) in cats.iter().filter(|c| !matched.contains(&c.0)) {
        let Ok(dir) = category::dir(lib, Some(*id)) else {
            continue; // 親と一緒に消えた
        };
        if walk.under_unreadable(&dir) {
            continue;
        }
        match fs::symlink_metadata(lib.root.join(&dir)) {
            Err(e) if e.kind() == ErrorKind::NotFound => {
                report.categories_removed += remove_category(lib, *id)?;
            }
            _ => walk.fail(
                lib.root.join(&dir),
                "カテゴリのフォルダを確かめられません".into(),
            ),
        }
    }

    report.skipped = walk.skipped;
    Ok(report)
}

fn errors_of(walk: &Walk) -> String {
    walk.skipped
        .iter()
        .filter_map(|s| match &s.reason {
            Reason::Error { message } => Some(message.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("、")
}

/// 同じハッシュの画像（ゴミ箱と見つからない画像を含む）の id
fn owner(lib: &Library, hash: &str) -> Result<Option<i64>, String> {
    lib.conn
        .query_row("SELECT id FROM images WHERE hash = ?1", [hash], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)
}

/// 見つかったファイルに合わせて行を更新し、見つからない状態を外す。category が Some なら移動として場所も更新する
fn set_found(
    lib: &Library,
    id: i64,
    f: &Found,
    category: Option<Option<i64>>,
) -> Result<(), String> {
    match category {
        Some(category) => lib.conn.execute(
            "UPDATE images SET category_id = ?1, file_name = ?2, file_size = ?3, file_mtime = ?4,
                    missing_at = NULL WHERE id = ?5",
            params![category, f.name, f.size, f.mtime, id],
        ),
        None => lib.conn.execute(
            "UPDATE images SET file_size = ?1, file_mtime = ?2, missing_at = NULL WHERE id = ?3",
            params![f.size, f.mtime, id],
        ),
    }
    .map(|_| ())
    .map_err(err)
}

/// カテゴリを子孫ごと消す。中に残った画像は未分類にし（見つからない状態になっている）、
/// ゴミ箱の画像はカテゴリの削除（FR-404）と同じく元のカテゴリが消えた印を付ける。返り値は消したカテゴリの数
fn remove_category(lib: &mut Library, id: i64) -> Result<usize, String> {
    let tx = lib.conn.transaction().map_err(err)?;
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE images SET category_id = NULL,
                category_deleted = (deleted_at IS NOT NULL)
             WHERE category_id IN sub"
        ),
        [id],
    )
    .map_err(err)?;
    let n = tx
        .execute(
            &format!("{SUBTREE} DELETE FROM categories WHERE id IN sub"),
            [id],
        )
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(n)
}

fn remove_thumb(root: &Path, hash: &str) {
    let thumb = root
        .join(KURA_DIR)
        .join("thumbs")
        .join(format!("{hash}.jpg"));
    if let Err(e) = fs::remove_file(&thumb) {
        log::warn!("サムネイルを消せません（{}、{e}）", thumb.display());
    }
}

/// 見つからない画像を DB から外す（FR-104）。行（タグの付き方と元URLを含む）とサムネイルを消す。
/// 見つからない状態でない画像は外さずに failed に入れる
pub fn forget(lib: &mut Library, ids: &[i64]) -> Result<Done, String> {
    let mut out = Done::default();
    for &id in ids {
        let hash: Option<String> = lib
            .conn
            .query_row(
                "SELECT hash FROM images
                 WHERE id = ?1 AND deleted_at IS NULL AND missing_at IS NOT NULL",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let result = match hash {
            None => Err(format!("見つからない画像ではありません（{id}）")),
            Some(hash) => trash::forget(lib, id).map(|_| remove_thumb(&lib.root, &hash)),
        };
        match result {
            Ok(()) => out.done.push(id),
            Err(message) => out.failed.push(Failed { id, message }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use image::{Rgb, RgbImage};
    use rusqlite::params;
    use unicode_normalization::UnicodeNormalization;

    use super::*;
    use crate::category::tests::setup;
    use crate::import::Reason;
    use crate::library::KURA_DIR;
    use crate::{category, gallery};

    /// ライブラリの rel に、shade の色の 4x4 の PNG を Finder で置いたかのように書く
    fn png(lib: &Library, rel: &str, shade: u8) {
        let path = lib.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        RgbImage::from_pixel(4, 4, Rgb([shade, 0, 0]))
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
    }

    fn touch(lib: &Library, rel: &str) {
        fs::File::options()
            .write(true)
            .open(lib.root.join(rel))
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000))
            .unwrap();
    }

    #[derive(Debug, PartialEq)]
    struct Row {
        file_name: String,
        category_id: Option<i64>,
        missing: bool,
    }

    fn row(lib: &Library, id: i64) -> Row {
        lib.conn
            .query_row(
                "SELECT file_name, category_id, missing_at IS NOT NULL FROM images WHERE id = ?1",
                [id],
                |r| {
                    Ok(Row {
                        file_name: r.get(0)?,
                        category_id: r.get(1)?,
                        missing: r.get(2)?,
                    })
                },
            )
            .unwrap()
    }

    fn id_of(lib: &Library, file_name: &str) -> i64 {
        lib.conn
            .query_row(
                "SELECT id FROM images WHERE file_name = ?1",
                [file_name],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn count(lib: &Library, table: &str) -> i64 {
        lib.conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn hash(lib: &Library, id: i64) -> String {
        lib.conn
            .query_row("SELECT hash FROM images WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn category_named(lib: &Library, name: &str) -> Option<i64> {
        lib.conn
            .query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
                r.get(0)
            })
            .ok()
    }

    fn tag(lib: &Library, id: i64) {
        lib.conn
            .execute("INSERT INTO tags(name) VALUES ('座り')", [])
            .unwrap();
        lib.conn
            .execute(
                "INSERT INTO image_tags VALUES (?1, ?2)",
                params![id, lib.conn.last_insert_rowid()],
            )
            .unwrap();
    }

    fn tags(lib: &Library, id: i64) -> i64 {
        lib.conn
            .query_row(
                "SELECT count(*) FROM image_tags WHERE image_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn errors(report: &Report) -> Vec<String> {
        report
            .skipped
            .iter()
            .filter_map(|s| match &s.reason {
                Reason::Error { message } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    fn thumb(lib: &Library, hash: &str) -> std::path::PathBuf {
        lib.root
            .join(KURA_DIR)
            .join("thumbs")
            .join(format!("{hash}.jpg"))
    }

    #[test]
    fn finderで作ったフォルダと置いた画像を登録する() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/座り/a.png", 10);
        png(&lib, "_未分類/b.png", 20);

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.added, r.categories_added), (2, 2));
        let pose = category_named(&lib, "ポーズ").unwrap();
        let sit = category_named(&lib, "座り").unwrap();
        assert_eq!(
            category::dir(&lib, Some(sit)).unwrap(),
            Path::new("ポーズ/座り")
        );
        let a = id_of(&lib, "a.png");
        assert_eq!(row(&lib, a).category_id, Some(sit));
        assert_eq!(row(&lib, id_of(&lib, "b.png")).category_id, None);
        assert!(thumb(&lib, &hash(&lib, a)).is_file());
        let (w, size): (i64, i64) = lib
            .conn
            .query_row(
                "SELECT width, file_size FROM images WHERE id = ?1",
                [a],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(w, 4);
        assert_eq!(
            size,
            fs::metadata(lib.root.join("ポーズ/座り/a.png"))
                .unwrap()
                .len() as i64
        );
        assert!(gallery::load(&lib)
            .unwrap()
            .categories
            .iter()
            .any(|c| c.id == pose));
    }

    #[test]
    fn 変化がなければ二度目は何も変えない() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/a.png", 10);
        scan(&mut lib).unwrap();

        assert_eq!(scan(&mut lib).unwrap(), Report::default());
        assert_eq!(count(&lib, "images"), 1);
        assert_eq!(count(&lib, "categories"), 1);
    }

    #[test]
    fn サイズと更新日時が同じファイルはハッシュを計算し直さない() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        // 計算し直せば実ファイルのハッシュに戻るので、戻らなければ計算していない
        lib.conn
            .execute("UPDATE images SET hash = 'stale' WHERE id = ?1", [a])
            .unwrap();

        scan(&mut lib).unwrap();

        assert_eq!(hash(&lib, a), "stale");
    }

    #[test]
    fn 更新日時だけが変わり中身が同じならサイズと更新日時だけを更新する() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        let before = hash(&lib, a);
        lib.conn
            .execute("UPDATE images SET file_mtime = 1 WHERE id = ?1", [a])
            .unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.updated, r.added, r.missing), (0, 0, 0));
        assert_eq!(hash(&lib, a), before);
        let mtime: i64 = lib
            .conn
            .query_row("SELECT file_mtime FROM images WHERE id = ?1", [a], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(mtime, 1);
        assert_eq!(scan(&mut lib).unwrap(), Report::default());
    }

    #[test]
    fn finderで消した画像は行を残して見つからない状態にし一覧から外す() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        tag(&lib, a);
        fs::remove_file(lib.root.join("ポーズ/a.png")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!(r.missing, 1);
        let pose = category_named(&lib, "ポーズ");
        assert_eq!(
            row(&lib, a),
            Row {
                file_name: "a.png".into(),
                category_id: pose,
                missing: true
            }
        );
        assert_eq!(tags(&lib, a), 1);
        assert!(gallery::load(&lib).unwrap().images.is_empty());
        assert_eq!(gallery::missing(&lib).unwrap()[0].id, a);
        // 二度目は数え直さない
        assert_eq!(scan(&mut lib).unwrap().missing, 0);
    }

    #[test]
    fn 見つからなかったファイルが元の場所に戻れば状態を外す() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        fs::rename(lib.root.join("_未分類/a.png"), lib.root.join("a.tmp")).unwrap();
        scan(&mut lib).unwrap();
        fs::rename(lib.root.join("a.tmp"), lib.root.join("_未分類/a.png")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!(r.returned, 1);
        assert!(!row(&lib, a).missing);
        assert!(gallery::missing(&lib).unwrap().is_empty());
    }

    #[test]
    fn 同じハッシュのファイルが別の場所にあれば移動とみなしてカテゴリとファイル名を更新する() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/a.png", 10);
        png(&lib, "服飾/b.png", 20);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        tag(&lib, a);
        fs::rename(lib.root.join("ポーズ/a.png"), lib.root.join("服飾/c.png")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.moved, r.added, r.missing), (1, 0, 0));
        assert_eq!(
            row(&lib, a),
            Row {
                file_name: "c.png".into(),
                category_id: category_named(&lib, "服飾"),
                missing: false
            }
        );
        assert_eq!(tags(&lib, a), 1);
        assert_eq!(count(&lib, "images"), 2);
    }

    #[test]
    fn 見つからない状態の画像も後で別の場所に見つかれば移動とみなす() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        fs::rename(lib.root.join("_未分類/a.png"), lib.root.join("a.tmp")).unwrap();
        scan(&mut lib).unwrap();
        fs::create_dir(lib.root.join("ポーズ")).unwrap();
        fs::rename(lib.root.join("a.tmp"), lib.root.join("ポーズ/a.png")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.moved, r.added), (1, 0));
        assert_eq!(row(&lib, a).category_id, category_named(&lib, "ポーズ"));
        assert!(!row(&lib, a).missing);
    }

    #[test]
    fn 同じ場所で中身が変わったら同じ画像として更新しタグを残す() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        tag(&lib, a);
        let old = hash(&lib, a);
        RgbImage::from_pixel(8, 2, Rgb([0, 0, 255]))
            .save_with_format(lib.root.join("_未分類/a.png"), image::ImageFormat::Png)
            .unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.updated, r.added, r.missing), (1, 0, 0));
        let new = hash(&lib, a);
        assert_ne!(new, old);
        let (w, h, color): (i64, i64, String) = lib
            .conn
            .query_row(
                "SELECT width, height, color FROM images WHERE id = ?1",
                [a],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((w, h), (8, 2));
        assert_eq!(color, "#0000ff");
        assert!(thumb(&lib, &new).is_file());
        assert!(!thumb(&lib, &old).exists());
        assert_eq!(tags(&lib, a), 1);
        assert_eq!(scan(&mut lib).unwrap(), Report::default());
    }

    #[test]
    fn 中身が別の画像と同じになったら古い行を見つからないにして重複として知らせる() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        png(&lib, "_未分類/b.png", 20);
        scan(&mut lib).unwrap();
        let (a, b) = (id_of(&lib, "a.png"), id_of(&lib, "b.png"));
        fs::copy(
            lib.root.join("_未分類/b.png"),
            lib.root.join("_未分類/a.png"),
        )
        .unwrap();
        // copy は更新日時も写すので、同じ大きさの b と区別できるよう変える
        touch(&lib, "_未分類/a.png");

        let r = scan(&mut lib).unwrap();

        assert!(row(&lib, a).missing);
        assert!(!row(&lib, b).missing);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].reason, Reason::Duplicate { existing: b });
    }

    #[test]
    fn 新しいファイルがライブラリかゴミ箱の画像と同じなら登録せず重複として知らせる() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        png(&lib, "_未分類/b.png", 20);
        scan(&mut lib).unwrap();
        let (a, b) = (id_of(&lib, "a.png"), id_of(&lib, "b.png"));
        crate::trash::trash(&mut lib, &[b]).unwrap();
        fs::create_dir(lib.root.join("ポーズ")).unwrap();
        fs::copy(
            lib.root.join("_未分類/a.png"),
            lib.root.join("ポーズ/a2.png"),
        )
        .unwrap();
        png(&lib, "ポーズ/b2.png", 20);

        let r = scan(&mut lib).unwrap();

        assert_eq!(r.added, 0);
        let mut existing: Vec<_> = r.skipped.iter().map(|s| s.reason.clone()).collect();
        existing.sort_by_key(|r| format!("{r:?}"));
        assert_eq!(
            existing,
            [
                Reason::Duplicate { existing: a },
                Reason::Duplicate { existing: b }
            ]
        );
        assert_eq!(count(&lib, "images"), 2);
        // 取り込みの例外（未分類の画像を移す）は使わない
        assert_eq!(row(&lib, a).category_id, None);
    }

    #[test]
    fn フォルダを消すとカテゴリを子孫ごと消し中の画像は未分類で見つからないにする() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/座り/a.png", 10);
        png(&lib, "ポーズ/b.png", 20);
        png(&lib, "服飾/c.png", 30);
        scan(&mut lib).unwrap();
        let (a, b) = (id_of(&lib, "a.png"), id_of(&lib, "b.png"));
        tag(&lib, a);
        crate::trash::trash(&mut lib, &[b]).unwrap();
        fs::remove_dir_all(lib.root.join("ポーズ")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.categories_removed, r.missing), (2, 1));
        assert_eq!(category_named(&lib, "ポーズ"), None);
        assert_eq!(category_named(&lib, "座り"), None);
        assert!(category_named(&lib, "服飾").is_some());
        assert_eq!(
            row(&lib, a),
            Row {
                file_name: "a.png".into(),
                category_id: None,
                missing: true
            }
        );
        assert_eq!(tags(&lib, a), 1);
        // ゴミ箱の画像は FR-404 と同じく、元のカテゴリが消えた印を付ける
        let (cat, deleted): (Option<i64>, bool) = lib
            .conn
            .query_row(
                "SELECT category_id, category_deleted FROM images WHERE id = ?1",
                [b],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((cat, deleted), (None, true));
        assert_eq!(scan(&mut lib).unwrap(), Report::default());
    }

    #[test]
    fn フォルダの名前を変えると新しいカテゴリへ画像を移し古いカテゴリを消す() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/座り/a.png", 10);
        scan(&mut lib).unwrap();
        let a = id_of(&lib, "a.png");
        tag(&lib, a);
        fs::rename(lib.root.join("ポーズ/座り"), lib.root.join("ポーズ/椅子")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.categories_added, r.categories_removed), (1, 1));
        assert_eq!((r.moved, r.missing), (1, 0));
        assert_eq!(category_named(&lib, "座り"), None);
        assert_eq!(row(&lib, a).category_id, category_named(&lib, "椅子"));
        assert!(!row(&lib, a).missing);
        assert_eq!(tags(&lib, a), 1);
    }

    #[test]
    fn 大文字小文字だけを変えたフォルダは同じカテゴリの名前を合わせる() {
        let (_d, mut lib) = setup();
        png(&lib, "Pose/a.png", 10);
        scan(&mut lib).unwrap();
        let pose = category_named(&lib, "Pose").unwrap();
        fs::rename(lib.root.join("Pose"), lib.root.join("tmp")).unwrap();
        fs::rename(lib.root.join("tmp"), lib.root.join("pose")).unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!(
            (r.categories_added, r.categories_removed, r.moved),
            (0, 0, 0)
        );
        assert_eq!(category_named(&lib, "pose"), Some(pose));
        assert!(!row(&lib, id_of(&lib, "a.png")).missing);
    }

    #[test]
    fn nfdの名前のフォルダとファイルもnfcのdbと同じとみなす() {
        let (_d, mut lib) = setup();
        let pose = category::create(&mut lib, None, "ポーズ").unwrap();
        let nfd: String = "ポーズ/パ.png".nfd().collect();
        png(&lib, &nfd, 10);
        scan(&mut lib).unwrap();
        let p = id_of(&lib, "パ.png");

        assert_eq!(count(&lib, "categories"), 1);
        assert_eq!(row(&lib, p).category_id, Some(pose));
        assert_eq!(scan(&mut lib).unwrap(), Report::default());
    }

    #[test]
    fn 読めないフォルダはカテゴリを消さず中の画像も見つからないにせずエラーで知らせる() {
        let (_d, mut lib) = setup();
        png(&lib, "ポーズ/a.png", 10);
        png(&lib, "ポーズ/座り/b.png", 20);
        scan(&mut lib).unwrap();
        let dir = lib.root.join("ポーズ");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&dir).is_ok() {
            // exFAT と FAT32 は Unix の権限を持たないので、読み取りを止められない
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skip: {} は権限で読み取りを止められない", dir.display());
            return;
        }

        let r = scan(&mut lib);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let r = r.unwrap();

        assert_eq!((r.categories_removed, r.missing), (0, 0));
        assert_eq!(count(&lib, "categories"), 2);
        assert!(errors(&r)[0].contains("フォルダを読めません"), "{r:?}");
        assert!(!row(&lib, id_of(&lib, "b.png")).missing);
    }

    #[test]
    fn 直下の画像と未分類の下のフォルダと使えない名前のフォルダは登録せず知らせる() {
        let (_d, mut lib) = setup();
        png(&lib, "a.png", 10);
        png(&lib, "_未分類/中/b.png", 20);
        png(&lib, "ポーズ/_未分類/c.png", 30);

        let r = scan(&mut lib).unwrap();

        assert_eq!(r.added, 0);
        assert_eq!(count(&lib, "images"), 0);
        assert_eq!(count(&lib, "categories"), 1);
        assert_eq!(errors(&r).len(), 3, "{r:?}");
    }

    #[test]
    fn 隠しファイルと管理フォルダは見ず対応していない形式は知らせる() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/.hidden.png", 10);
        png(&lib, ".隠し/a.png", 20);
        fs::write(lib.root.join("_未分類/メモ.txt"), b"text").unwrap();

        let r = scan(&mut lib).unwrap();

        assert_eq!((r.added, r.categories_added), (0, 0));
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].reason, Reason::Unsupported);
    }

    #[test]
    fn 見つからない画像をdbから外すと行とタグとサムネイルを消す() {
        let (_d, mut lib) = setup();
        png(&lib, "_未分類/a.png", 10);
        png(&lib, "_未分類/b.png", 20);
        scan(&mut lib).unwrap();
        let (a, b) = (id_of(&lib, "a.png"), id_of(&lib, "b.png"));
        tag(&lib, a);
        let h = hash(&lib, a);
        fs::remove_file(lib.root.join("_未分類/a.png")).unwrap();
        scan(&mut lib).unwrap();

        let done = forget(&mut lib, &[a, b]).unwrap();

        assert_eq!(done.done, [a]);
        // 見つかっている画像は外さない
        assert_eq!(done.failed[0].id, b);
        assert_eq!(count(&lib, "images"), 1);
        assert_eq!(count(&lib, "image_tags"), 0);
        assert!(!thumb(&lib, &h).exists());
        assert!(lib.root.join("_未分類/b.png").is_file());
    }
}
