//! 書き出した管理情報を戻す（FR-107、ADR-0032）

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::library::{self, err, Library, BACKUP_DIR, KURA_DIR, MIGRATIONS, UNCATEGORIZED_DIR};

/// 選んだ管理情報を確かめた結果。確認ダイアログに出す
#[derive(Debug, PartialEq, Serialize)]
pub struct Inspected {
    /// 書き出した日時（ファイルの更新日時、UNIX 時間のミリ秒）
    pub exported_at: i64,
    /// 選んだ管理情報と今の管理情報の、ゴミ箱と見つからない画像を除いた画像の枚数
    pub images: usize,
    pub current: usize,
    /// 選んだ管理情報の画像のうち、ライブラリの中に見つかる枚数
    pub found: usize,
    /// 見つかる画像が半分に満たない。別のライブラリの管理情報かもしれない
    pub other_library: bool,
}

const NOT_BACKUP: &str =
    "管理情報のファイルではありません。「管理情報をエクスポート…」でエクスポートしたファイルを選んでください";

/// 選んだファイルを読み取り専用で開き、戻せる管理情報かを確かめる
fn open_source(src: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| NOT_BACKUP.to_string())?;
    // 画像などは開くだけでは断られず、最初の問い合わせで「file is not a database」になる
    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table'
             AND name IN ('images', 'categories', 'pending_ops')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| NOT_BACKUP.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| NOT_BACKUP.to_string())?;
    if tables != 3 || version < 1 {
        return Err(NOT_BACKUP.into());
    }
    if version as usize > MIGRATIONS.len() {
        return Err(
            "アプリより新しい版でエクスポートした管理情報です。アプリを更新してからインポートしてください".into(),
        );
    }
    Ok(conn)
}

/// ゴミ箱と見つからない画像を除いた画像の、ライブラリからの相対パス。どの版の管理情報にもある列だけを読む
fn image_paths(conn: &Connection) -> Result<Vec<PathBuf>, String> {
    let categories: HashMap<i64, (Option<i64>, String)> = conn
        .prepare("SELECT id, parent_id, name FROM categories")
        .map_err(err)?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let dir = |id: Option<i64>| -> Option<PathBuf> {
        let Some(mut id) = id else {
            return Some(PathBuf::from(UNCATEGORIZED_DIR));
        };
        let mut names = vec![];
        // 壊れた親子関係で巡回しても止まるよう、カテゴリの数より深くはたどらない
        for _ in 0..=categories.len() {
            let (parent, name) = categories.get(&id)?;
            names.push(name.as_str());
            match parent {
                Some(p) => id = *p,
                None => return Some(names.iter().rev().collect()),
            }
        }
        None
    };
    conn.prepare(
        "SELECT category_id, file_name FROM images WHERE deleted_at IS NULL AND missing_at IS NULL",
    )
    .map_err(err)?
    .query_map([], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?))
    })
    .map_err(err)?
    .map(|row| {
        let (category, name) = row.map_err(err)?;
        // 道筋をたどれない画像は見つからない画像として数える
        Ok(dir(category).map_or_else(PathBuf::new, |d| d.join(name)))
    })
    .collect()
}

pub fn inspect(lib: &Library, src: &Path) -> Result<Inspected, String> {
    let source = open_source(src)?;
    let paths = image_paths(&source)?;
    let found = paths
        .iter()
        .filter(|p| !p.as_os_str().is_empty() && lib.root.join(p).is_file())
        .count();
    let modified = fs::metadata(src)
        .and_then(|m| m.modified())
        .map_err(err)?
        .duration_since(UNIX_EPOCH)
        .map_err(err)?;
    Ok(Inspected {
        exported_at: modified.as_millis() as i64,
        images: paths.len(),
        current: image_paths(&lib.conn)?.len(),
        found,
        other_library: found * 2 < paths.len(),
    })
}

/// slot のライブラリの管理情報を、src の管理情報に置き換えて開き直す。置き換える前の管理情報の写しを
/// .kura/backups に残す。置き換える前に失敗したら、今の管理情報には触れない。置き換えた管理情報を
/// 開けなければ、写しから戻して開き直す。どの場合も、終わったときに開けたライブラリを slot に置く
pub fn restore(slot: &mut Option<Library>, src: &Path) -> Result<(), String> {
    let lib = slot.as_ref().ok_or("ライブラリを開いていません")?;
    let root = lib.root.clone();
    let db = root.join(KURA_DIR).join("kura.db");
    let staged = root.join(KURA_DIR).join("kura.db.restore");
    // 今の DB に触れる前に、置き換える中身を同じフォルダにそろえる。rename で1度に入れ替えるため
    let stage = || -> Result<(), String> {
        library::write_copy(&open_source(src)?, &staged)?;
        // 書き出した時点で途中だった予定は、その後にファイルが動いているので後始末させない。
        // 食い違いは開き直した後の差分検出（FR-104）が反映する
        Connection::open(&staged)
            .and_then(|c| c.execute("DELETE FROM pending_ops", []))
            .map_err(err)?;
        Ok(())
    };
    let before = root.join(BACKUP_DIR).join(format!(
        "kura-before-restore-{}.db",
        library::stamp(&lib.conn)?
    ));
    let prepared = stage()
        .and_then(|()| {
            fs::create_dir_all(root.join(BACKUP_DIR))
                .map_err(err)
                .and_then(|()| library::write_copy(&lib.conn, &before))
                .map_err(|e| {
                    format!(
                        "インポートする前の管理情報の写しを書けないので、インポートしません（{e}）"
                    )
                })
        })
        // WAL を本体に書き戻して空にする。閉じた後に残った WAL が、置き換えた DB に当てられないように
        .and_then(|()| {
            lib.conn
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .map_err(err)
        });
    if let Err(e) = prepared {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    // 排他ロックを外すため、置き換える前に閉じる
    drop(slot.take());
    let swapped = remove_wal(&db).and_then(|()| fs::rename(&staged, &db).map_err(err));
    if let Err(e) = swapped {
        let _ = fs::remove_file(&staged);
        *slot = library::open(&root).ok();
        return Err(format!(
            "管理情報を置き換えられないので、インポートしません（{e}）"
        ));
    }
    match library::open(&root) {
        Ok(lib) => {
            *slot = Some(lib);
            Ok(())
        }
        Err(e) => {
            let back = library::write_copy(&Connection::open(&before).map_err(err)?, &staged)
                .and_then(|()| remove_wal(&db))
                .and_then(|()| fs::rename(&staged, &db).map_err(err));
            *slot = back.as_ref().ok().and_then(|()| library::open(&root).ok());
            match (back, slot.is_some()) {
                (Ok(()), true) => Err(format!(
                    "インポートした管理情報を開けないので、インポートする前の管理情報に戻しました（{e}）"
                )),
                _ => Err(format!(
                    "インポートした管理情報を開けず、インポートする前の管理情報にも戻せませんでした。{} の写しを確かめてください（{e}）",
                    before.display()
                )),
            }
        }
    }
}

/// 閉じた DB の WAL と共有メモリのファイルを消す。ないのはかまわない
fn remove_wal(db: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        match fs::remove_file(PathBuf::from(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(e)),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::category::tests::{put, setup};

    fn export(lib: &Library, dir: &Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        library::backup(lib, &path).unwrap();
        path
    }

    fn memo(lib: &Library, id: i64) -> String {
        lib.conn
            .query_row("SELECT memo FROM images WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn set_memo(lib: &Library, id: i64, memo: &str) {
        lib.conn
            .execute(
                "UPDATE images SET memo = ?1 WHERE id = ?2",
                rusqlite::params![memo, id],
            )
            .unwrap();
    }

    fn backups(lib_root: &Path, prefix: &str) -> Vec<std::path::PathBuf> {
        let Ok(entries) = fs::read_dir(lib_root.join(BACKUP_DIR)) else {
            return vec![];
        };
        entries
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(prefix))
            .collect()
    }

    // .kura/ の中身。戻した後に一時ファイルを残していないかを見る
    fn kura_files(root: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(root.join(KURA_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn 書き出した日時と両方の枚数と見つかる枚数を返す() {
        let (dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        put(&lib, None, "a.png", "a");
        let b = put(&lib, None, "b.png", "b");
        lib.conn
            .execute("UPDATE images SET deleted_at = 1 WHERE id = ?1", [b])
            .unwrap();
        put(&lib, None, "c.png", "c");
        let file = export(&lib, out.path(), "書き出し.db");
        put(&lib, None, "d.png", "d");

        let got = inspect(&lib, &file).unwrap();

        let mtime = fs::metadata(&file).unwrap().modified().unwrap();
        let ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(
            got,
            Inspected {
                exported_at: ms,
                images: 2,
                current: 3,
                found: 2,
                other_library: false
            }
        );
        drop(dir);
    }

    #[test]
    fn 見つかる画像が半分に満たなければ別のライブラリかもしれないとする() {
        let (_a_dir, a) = setup();
        let (_b_dir, b) = setup();
        let out = tempfile::tempdir().unwrap();
        put(&b, None, "共通.png", "1");
        put(&b, None, "別1.png", "2");
        put(&b, None, "別2.png", "3");
        let file = export(&b, out.path(), "b.db");
        put(&a, None, "共通.png", "1");

        let got = inspect(&a, &file).unwrap();
        assert_eq!((got.images, got.found, got.other_library), (3, 1, true));

        // ちょうど半分なら警告しない
        fs::write(a.root.join(library::UNCATEGORIZED_DIR).join("別1.png"), "2").unwrap();
        let got = inspect(&a, &file).unwrap();
        assert!(got.found == 2 && !got.other_library);
    }

    #[test]
    fn 新しい版と管理情報でないファイルは確かめる段階で断る() {
        let (_dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        let newer = export(&lib, out.path(), "newer.db");
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", 999)
            .unwrap();
        assert!(inspect(&lib, &newer).unwrap_err().contains("新しい版"));

        let image = out.path().join("画像.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\n not a database").unwrap();
        let empty = out.path().join("空.db");
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE t(x)")
            .unwrap();
        for file in [image, empty, out.path().join("ない.db")] {
            assert!(
                inspect(&lib, &file)
                    .unwrap_err()
                    .contains("管理情報のファイルではありません"),
                "{}",
                file.display()
            );
        }
    }

    #[test]
    fn 戻すと書き出した管理情報で開き直し戻す前の写しを残し画像と特徴量は変えない() {
        let (dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        let image = put(&lib, None, "a.png", "a");
        set_memo(&lib, image, "書き出した時");
        // 書き出した時点で途中だった予定は、戻した後に後始末させない。ファイルはその後も動いている
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES ('move_image', ?1, 0, 'x', 'y')",
                [image],
            )
            .unwrap();
        let file = export(&lib, out.path(), "書き出し.db");
        lib.conn.execute("DELETE FROM pending_ops", []).unwrap();
        set_memo(&lib, image, "戻す前");
        let features = dir.path().join(KURA_DIR).join("features.db");
        fs::write(&features, "特徴量").unwrap();
        let root = lib.root.clone();
        let mut slot = Some(lib);

        restore(&mut slot, &file).unwrap();

        let lib = slot.unwrap();
        assert_eq!(memo(&lib, image), "書き出した時");
        let pending: i64 = lib
            .conn
            .query_row("SELECT count(*) FROM pending_ops", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pending, 0);
        assert_eq!(
            fs::read_to_string(root.join(library::UNCATEGORIZED_DIR).join("a.png")).unwrap(),
            "a"
        );
        assert_eq!(fs::read_to_string(&features).unwrap(), "特徴量");
        let before = backups(&root, "kura-before-restore-");
        assert_eq!(before.len(), 1);
        let saved: String = Connection::open(&before[0])
            .unwrap()
            .query_row("SELECT memo FROM images WHERE id = ?1", [image], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(saved, "戻す前");
        assert!(
            kura_files(&root).iter().all(|n| !n.contains("restore")),
            "{:?}",
            kura_files(&root)
        );
    }

    #[test]
    fn 古い版の管理情報は戻した後に移行し移行前の写しも残す() {
        let (_dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        let old = out.path().join("古い版.db");
        let conn = Connection::open(&old).unwrap();
        for sql in &MIGRATIONS[..7] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();
        drop(conn);
        let root = lib.root.clone();
        let mut slot = Some(lib);

        restore(&mut slot, &old).unwrap();

        let version: i64 = slot
            .as_ref()
            .unwrap()
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert_eq!(backups(&root, "kura-v7-").len(), 1);
        assert_eq!(backups(&root, "kura-before-restore-").len(), 1);
    }

    #[test]
    fn 写しを書けないときと新しい版と壊れたファイルでは今の管理情報を変えない() {
        let (_dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        let image = put(&lib, None, "a.png", "a");
        let file = export(&lib, out.path(), "書き出し.db");
        set_memo(&lib, image, "今");
        let root = lib.root.clone();
        let mut slot = Some(lib);

        // 写しの置き場所をファイルにして、写しを書けなくする
        fs::write(root.join(BACKUP_DIR), "").unwrap();
        assert!(restore(&mut slot, &file).unwrap_err().contains("写し"));
        assert_eq!(memo(slot.as_ref().unwrap(), image), "今");
        fs::remove_file(root.join(BACKUP_DIR)).unwrap();

        let newer = export(slot.as_ref().unwrap(), out.path(), "newer.db");
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", 999)
            .unwrap();
        let broken = out.path().join("壊れた.db");
        fs::write(&broken, "SQLite format 3\0 でも中身は壊れている").unwrap();
        for bad in [newer, broken] {
            assert!(restore(&mut slot, &bad).is_err(), "{}", bad.display());
            assert_eq!(memo(slot.as_ref().unwrap(), image), "今");
        }
        assert!(backups(&root, "kura-before-restore-").is_empty());
        assert!(
            kura_files(&root).iter().all(|n| !n.contains("restore")),
            "{:?}",
            kura_files(&root)
        );
    }

    #[test]
    fn 戻した管理情報を開けなければ戻す前の管理情報で開き直す() {
        let (_dir, lib) = setup();
        let out = tempfile::tempdir().unwrap();
        let image = put(&lib, None, "a.png", "a");
        set_memo(&lib, image, "今");
        // 確かめには通るが、最後の移行（board_state に列を足す）で失敗する管理情報
        let bad = out.path().join("移行できない.db");
        let conn = Connection::open(&bad).unwrap();
        for sql in &MIGRATIONS[..2] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE images(id INTEGER PRIMARY KEY, file_name TEXT, category_id INTEGER,
                                 deleted_at INTEGER, missing_at INTEGER)",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 - 1)
            .unwrap();
        drop(conn);
        let root = lib.root.clone();
        let mut slot = Some(lib);

        let e = restore(&mut slot, &bad).unwrap_err();

        assert!(e.contains("インポートする前の管理情報に戻しました"), "{e}");
        assert_eq!(memo(slot.as_ref().unwrap(), image), "今");
        assert_eq!(backups(&root, "kura-before-restore-").len(), 1);
    }
}
