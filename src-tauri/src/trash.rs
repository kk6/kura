use std::fmt::Display;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;

use crate::category::{self, Failed, Moved};
use crate::fileops::{self, OnConflict, PendingOp, Request};
use crate::library::{Library, KURA_DIR, TRASH_DIR};

/// 画像をゴミ箱へ移す操作と、ゴミ箱から戻す操作の、pending_ops の種類
pub const TRASH_IMAGE: &str = "trash_image";
pub const RESTORE_IMAGE: &str = "restore_image";

fn err(e: impl Display) -> String {
    e.to_string()
}

#[derive(Debug, Default, Serialize)]
pub struct Done {
    pub done: Vec<i64>,
    pub failed: Vec<Failed>,
}

#[derive(Debug, Default, Serialize)]
pub struct Restored {
    pub moved: Vec<Moved>,
    pub failed: Vec<Failed>,
    /// 元のカテゴリが削除されていたので、未分類へ戻した画像
    pub uncategorized: Vec<i64>,
}

/// ゴミ箱の中のファイル（ライブラリからの相対パス）。名前を画像の id にし、ゴミ箱の中で衝突しないようにする
fn trash_path(id: i64, file_name: &str) -> PathBuf {
    Path::new(TRASH_DIR).join(match fileops::split_ext(file_name) {
        (_, "") => id.to_string(),
        (_, ext) => format!("{id}.{ext}"),
    })
}

/// ids の画像をゴミ箱へ移す（FR-511）。DB にはカテゴリとファイル名を残し、削除日時を入れる。
/// 1枚ずつ移し、移せない画像はファイルも DB も元のまま failed に入れて、残りを続ける
pub fn trash(lib: &mut Library, ids: &[i64]) -> Result<Done, String> {
    fs::create_dir_all(lib.root.join(TRASH_DIR))
        .map_err(|e| format!("ゴミ箱のフォルダを作れません（{e}）"))?;
    let mut out = Done::default();
    for &id in ids {
        let result = category::locate(lib, id).and_then(|(dir, file_name)| {
            let dst = trash_path(id, &file_name);
            fileops::transfer(
                lib,
                Request {
                    kind: TRASH_IMAGE,
                    target_id: Some(id),
                    copy: false,
                    src: &dir.join(&file_name),
                    dst_dir: dst.parent().unwrap(),
                    name: &dst.file_name().unwrap().to_string_lossy(),
                    on_conflict: OnConflict::Fail,
                },
                &apply_trash,
            )
        });
        match result {
            Ok(_) => out.done.push(id),
            Err(message) => out.failed.push(Failed { id, message }),
        }
    }
    Ok(out)
}

/// TRASH_IMAGE の DB の更新。カテゴリとファイル名は元に戻すときのために残す
pub fn apply_trash(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_millis() as i64;
    let changed = tx
        .execute(
            "UPDATE images SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, op.target_id],
        )
        .map_err(err)?;
    match changed {
        0 => Err(format!("画像が見つかりません（{:?}）", op.target_id)),
        _ => Ok(()),
    }
}

/// ゴミ箱の画像を元のカテゴリのフォルダへ戻す（FR-511）。同名があれば連番を付ける。
/// 元のカテゴリが削除されていれば未分類へ戻し、uncategorized に入れる
pub fn restore(lib: &mut Library, ids: &[i64]) -> Result<Restored, String> {
    let mut out = Restored::default();
    for &id in ids {
        match restore_one(lib, id) {
            Ok((file_name, deleted)) => {
                out.moved.push(Moved { id, file_name });
                if deleted {
                    out.uncategorized.push(id);
                }
            }
            Err(message) => out.failed.push(Failed { id, message }),
        }
    }
    Ok(out)
}

fn restore_one(lib: &mut Library, id: i64) -> Result<(String, bool), String> {
    let (file_name, category_id, deleted): (String, Option<i64>, bool) = lib
        .conn
        .query_row(
            "SELECT file_name, category_id, category_deleted FROM images
             WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or(format!("ゴミ箱に画像が見つかりません（{id}）"))?;
    let dst = fileops::transfer(
        lib,
        Request {
            kind: RESTORE_IMAGE,
            target_id: Some(id),
            copy: false,
            src: &trash_path(id, &file_name),
            dst_dir: &category::dir(lib, category_id)?,
            name: &file_name,
            on_conflict: OnConflict::Number,
        },
        &apply_restore,
    )?;
    Ok((
        dst.file_name().unwrap().to_string_lossy().into_owned(),
        deleted,
    ))
}

/// RESTORE_IMAGE の DB の更新。カテゴリとファイル名は画像の移動と同じく移動先のパスから決める
pub fn apply_restore(tx: &Transaction, op: &PendingOp) -> Result<(), String> {
    category::apply_move(tx, op)?;
    tx.execute(
        "UPDATE images SET deleted_at = NULL, category_deleted = 0 WHERE id = ?1",
        [op.target_id],
    )
    .map(|_| ())
    .map_err(err)
}

/// ゴミ箱を空にする（FR-511）。1枚ずつ実ファイルを消してから、DB の行（タグと元URLを含む）を消し、最後にサムネイルを消す。
/// ファイルを先に消すのは、行が残っていれば、途中で止まってももう一度空にすると続きから消せるため。
/// 消せないファイルの画像は行を残し、元に戻せるようにする
pub fn empty(lib: &mut Library) -> Result<Done, String> {
    let ids = {
        let mut stmt = lib
            .conn
            .prepare("SELECT id FROM images WHERE deleted_at IS NOT NULL ORDER BY id")
            .map_err(err)?;
        let ids = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        ids
    };
    purge(lib, &ids)
}

/// ゴミ箱の画像のうち ids だけを完全に削除する。消し方は empty と同じ。ゴミ箱にない画像は消さずに failed に入れる
pub fn purge(lib: &mut Library, ids: &[i64]) -> Result<Done, String> {
    let mut out = Done::default();
    for &id in ids {
        match purge_one(lib, id) {
            Ok(()) => out.done.push(id),
            Err(message) => out.failed.push(Failed { id, message }),
        }
    }
    Ok(out)
}

fn purge_one(lib: &mut Library, id: i64) -> Result<(), String> {
    let (file_name, hash): (String, String) = lib
        .conn
        .query_row(
            "SELECT file_name, hash FROM images WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or(format!("ゴミ箱に画像が見つかりません（{id}）"))?;
    let path = lib.root.join(trash_path(id, &file_name));
    match fs::remove_file(&path) {
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("{} を消せません（{e}）", path.display()))
        }
        _ => forget(lib, id)?,
    }
    let thumb = lib
        .root
        .join(KURA_DIR)
        .join("thumbs")
        .join(format!("{hash}.jpg"));
    if let Err(e) = fs::remove_file(&thumb) {
        log::warn!("サムネイルを消せません（{}、{e}）", thumb.display());
    }
    Ok(())
}

pub(crate) fn forget(lib: &mut Library, id: i64) -> Result<(), String> {
    let tx = lib.conn.transaction().map_err(err)?;
    for sql in [
        "DELETE FROM image_tags WHERE image_id = ?1",
        "DELETE FROM image_sources WHERE image_id = ?1",
        "DELETE FROM images WHERE id = ?1",
    ] {
        tx.execute(sql, [id]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;
    use crate::category::tests::{files, lock, pending, put, read, row, setup, unlock};
    use crate::category::{create, delete};
    use crate::{gallery, library};

    fn deleted_at(lib: &Library, id: i64) -> Option<i64> {
        lib.conn
            .query_row("SELECT deleted_at FROM images WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
    }

    fn exists(lib: &Library, id: i64) -> bool {
        lib.conn
            .query_row("SELECT count(*) FROM images WHERE id = ?1", [id], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
            == 1
    }

    fn ids(failed: &[Failed]) -> Vec<i64> {
        failed.iter().map(|f| f.id).collect()
    }

    #[test]
    fn ゴミ箱へ移すと実ファイルを画像のidの名前で移し削除日時を入れカテゴリとファイル名は残す() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        let b = put(&lib, None, "b.png", "B");
        let c = put(&lib, None, "c.jpg", "C");

        let r = trash(&mut lib, &[a, b]).unwrap();

        assert_eq!(r.done, [a, b]);
        assert!(r.failed.is_empty());
        assert_eq!(
            files(&lib, TRASH_DIR),
            [format!("{a}.jpg"), format!("{b}.png")]
        );
        assert_eq!(read(&lib, &format!(".kura/trash/{a}.jpg")), "A");
        assert_eq!(files(&lib, "ポーズ"), Vec::<String>::new());
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(pose)));
        assert!(deleted_at(&lib, a).is_some());
        assert_eq!(deleted_at(&lib, c), None);
        let shown: Vec<i64> = gallery::load(&lib)
            .unwrap()
            .images
            .iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(shown, [c]);
        let mut listed: Vec<i64> = gallery::trash(&lib).unwrap().iter().map(|i| i.id).collect();
        listed.sort();
        assert_eq!(listed, [a, b]);
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 移せない画像はファイルもdbも元のままにして残りを移す() {
        let (_d, mut lib) = setup();
        let locked = create(&mut lib, None, "鍵付き").unwrap();
        let gone = put(&lib, None, "gone.jpg", "G");
        fs::remove_file(lib.root.join("_未分類/gone.jpg")).unwrap();
        let stuck = put(&lib, Some(locked), "stuck.jpg", "S");
        let a = put(&lib, None, "a.jpg", "A");
        trash(&mut lib, &[a]).unwrap();
        let c = put(&lib, None, "c.jpg", "C");
        let locked_dir = lib.root.join("鍵付き");
        if !lock(&locked_dir) {
            return;
        }

        let r = trash(&mut lib, &[gone, stuck, a, 999, c]);

        unlock(&locked_dir);
        let r = r.unwrap();
        assert_eq!(r.done, [c]);
        assert_eq!(ids(&r.failed), [gone, stuck, a, 999]);
        assert_eq!(files(&lib, "鍵付き"), ["stuck.jpg"]);
        assert_eq!(deleted_at(&lib, gone), None);
        assert_eq!(deleted_at(&lib, stuck), None);
        assert_eq!(
            files(&lib, TRASH_DIR),
            [format!("{a}.jpg"), format!("{c}.jpg")]
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ゴミ箱への移動が途中で止まったらライブラリを開いたときに完了させる() {
        let (dir, lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        fs::create_dir_all(lib.root.join(TRASH_DIR)).unwrap();
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES (?1, ?2, 0, '_未分類/a.jpg', ?3)",
                params![TRASH_IMAGE, a, format!(".kura/trash/{a}.jpg")],
            )
            .unwrap();
        fs::rename(
            lib.root.join("_未分類/a.jpg"),
            lib.root.join(format!(".kura/trash/{a}.jpg")),
        )
        .unwrap();
        drop(lib);

        let lib = library::open(dir.path()).unwrap();

        assert!(deleted_at(&lib, a).is_some());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 元に戻すと元のカテゴリのフォルダへ戻しタグとメモも残っている() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        lib.conn
            .execute_batch(&format!(
                "INSERT INTO tags(name) VALUES ('座り'); INSERT INTO image_tags VALUES ({a}, 1);
                 UPDATE images SET memo = '腕' WHERE id = {a};"
            ))
            .unwrap();
        trash(&mut lib, &[a]).unwrap();

        let r = restore(&mut lib, &[a]).unwrap();

        assert_eq!(
            r.moved,
            [Moved {
                id: a,
                file_name: "a.jpg".into()
            }]
        );
        assert!(r.failed.is_empty() && r.uncategorized.is_empty());
        assert_eq!(read(&lib, "ポーズ/a.jpg"), "A");
        assert_eq!(files(&lib, TRASH_DIR), Vec::<String>::new());
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(pose)));
        assert_eq!(deleted_at(&lib, a), None);
        let image = gallery::load(&lib).unwrap().images.remove(0);
        assert_eq!(
            (image.id, image.memo.as_str(), image.tags),
            (a, "腕", vec![1])
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 元の場所に同名のファイルがあれば連番を付けて戻す() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        trash(&mut lib, &[a]).unwrap();
        fs::write(lib.root.join("_未分類/A.jpg"), "Finder で置いた").unwrap();

        let r = restore(&mut lib, &[a]).unwrap();

        assert_eq!(
            r.moved,
            [Moved {
                id: a,
                file_name: "a (2).jpg".into()
            }]
        );
        assert_eq!(read(&lib, "_未分類/a (2).jpg"), "A");
        assert_eq!(read(&lib, "_未分類/A.jpg"), "Finder で置いた");
        assert_eq!(row(&lib, a), ("a (2).jpg".into(), None));
    }

    #[test]
    fn 元のカテゴリが削除されていれば未分類へ戻して知らせる() {
        let (_d, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let sit = create(&mut lib, Some(pose), "座り").unwrap();
        let a = put(&lib, Some(sit), "a.jpg", "A");
        let b = put(&lib, None, "b.jpg", "B");
        trash(&mut lib, &[a, b]).unwrap();
        assert!(delete(&mut lib, pose).unwrap().error.is_none());

        let r = restore(&mut lib, &[a, b]).unwrap();

        assert_eq!(r.uncategorized, [a]);
        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "b.jpg"]);
        assert_eq!(row(&lib, a), ("a.jpg".into(), None));
        let flag: bool = lib
            .conn
            .query_row(
                "SELECT category_deleted FROM images WHERE id = ?1",
                [a],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!flag, "戻した後は印を外す");
    }

    #[test]
    fn 戻せない画像はゴミ箱に残して残りを戻す() {
        let (_d, mut lib) = setup();
        let locked = create(&mut lib, None, "鍵付き").unwrap();
        let stuck = put(&lib, Some(locked), "stuck.jpg", "S");
        let a = put(&lib, None, "a.jpg", "A");
        let alive = put(&lib, None, "alive.jpg", "L");
        trash(&mut lib, &[stuck, a]).unwrap();
        let locked_dir = lib.root.join("鍵付き");
        if !lock(&locked_dir) {
            return;
        }

        let r = restore(&mut lib, &[stuck, alive, 999, a]);

        unlock(&locked_dir);
        let r = r.unwrap();
        assert_eq!(
            r.moved,
            [Moved {
                id: a,
                file_name: "a.jpg".into()
            }]
        );
        assert_eq!(ids(&r.failed), [stuck, alive, 999]);
        assert_eq!(files(&lib, TRASH_DIR), [format!("{stuck}.jpg")]);
        assert!(deleted_at(&lib, stuck).is_some());
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 元に戻すのが途中で止まったらライブラリを開いたときに完了させる() {
        let (dir, mut lib) = setup();
        let pose = create(&mut lib, None, "ポーズ").unwrap();
        let a = put(&lib, Some(pose), "a.jpg", "A");
        trash(&mut lib, &[a]).unwrap();
        lib.conn
            .execute(
                "INSERT INTO pending_ops(kind, target_id, copy, src, dst) VALUES (?1, ?2, 0, ?3, 'ポーズ/a.jpg')",
                params![RESTORE_IMAGE, a, format!(".kura/trash/{a}.jpg")],
            )
            .unwrap();
        fs::rename(
            lib.root.join(format!(".kura/trash/{a}.jpg")),
            lib.root.join("ポーズ/a.jpg"),
        )
        .unwrap();
        drop(lib);

        let lib = library::open(dir.path()).unwrap();

        assert_eq!(deleted_at(&lib, a), None);
        assert_eq!(row(&lib, a), ("a.jpg".into(), Some(pose)));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 空にするとゴミ箱の画像のファイルと行とタグと元urlとサムネイルを消しほかは残す() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        let b = put(&lib, None, "b.jpg", "B");
        let thumbs = lib.root.join(".kura/thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        // put はハッシュに中身の文字を入れる
        for h in ["A", "B"] {
            fs::write(thumbs.join(format!("{h}.jpg")), "").unwrap();
        }
        lib.conn
            .execute_batch(&format!(
                "INSERT INTO tags(name) VALUES ('座り');
                 INSERT INTO image_tags VALUES ({a}, 1), ({b}, 1);
                 INSERT INTO image_sources VALUES ({a}, 'https://example.com/a.jpg', NULL, 1);"
            ))
            .unwrap();
        trash(&mut lib, &[a]).unwrap();
        // カテゴリの削除（FR-404）でゴミ箱に残した、管理外のファイルのフォルダ
        fs::create_dir(lib.root.join(".kura/trash/ポーズ")).unwrap();
        fs::write(lib.root.join(".kura/trash/ポーズ/memo.txt"), "").unwrap();

        let r = empty(&mut lib).unwrap();

        assert_eq!(r.done, [a]);
        assert!(r.failed.is_empty());
        assert!(!exists(&lib, a));
        assert!(exists(&lib, b));
        assert_eq!(files(&lib, TRASH_DIR), ["ポーズ"]);
        assert_eq!(files(&lib, ".kura/thumbs"), ["B.jpg"]);
        let tagged: i64 = lib
            .conn
            .query_row("SELECT count(*) FROM image_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tagged, 1);
        let sources: i64 = lib
            .conn
            .query_row("SELECT count(*) FROM image_sources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sources, 0);
        assert_eq!(read(&lib, "_未分類/b.jpg"), "B");
    }

    #[test]
    fn 消せないファイルの画像は行を残して元に戻せる() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        trash(&mut lib, &[a]).unwrap();
        let trash_dir = lib.root.join(TRASH_DIR);
        if !lock(&trash_dir) {
            return;
        }

        let r = empty(&mut lib);

        unlock(&trash_dir);
        let r = r.unwrap();
        assert!(r.done.is_empty());
        assert_eq!(ids(&r.failed), [a]);
        assert!(exists(&lib, a));
        restore(&mut lib, &[a]).unwrap();
        assert_eq!(read(&lib, "_未分類/a.jpg"), "A");
    }

    #[test]
    fn 実ファイルが消えた後で止まったゴミ箱の画像も空にすると行を消す() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        trash(&mut lib, &[a]).unwrap();
        fs::remove_file(lib.root.join(format!(".kura/trash/{a}.jpg"))).unwrap();

        let r = empty(&mut lib).unwrap();

        assert_eq!(r.done, [a]);
        assert!(!exists(&lib, a));
    }

    #[test]
    fn 選んだ画像だけを完全に削除しゴミ箱にない画像は消さない() {
        let (_d, mut lib) = setup();
        let a = put(&lib, None, "a.jpg", "A");
        let b = put(&lib, None, "b.jpg", "B");
        let alive = put(&lib, None, "c.jpg", "C");
        trash(&mut lib, &[a, b]).unwrap();

        let r = purge(&mut lib, &[a, alive, 999]).unwrap();

        assert_eq!(r.done, [a]);
        assert_eq!(ids(&r.failed), [alive, 999]);
        assert!(!exists(&lib, a));
        assert!(exists(&lib, b) && exists(&lib, alive));
        assert_eq!(files(&lib, TRASH_DIR), [format!("{b}.jpg")]);
        assert_eq!(read(&lib, "_未分類/c.jpg"), "C");
    }
}
