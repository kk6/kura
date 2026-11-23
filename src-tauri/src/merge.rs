//! 元が同じ画像を1枚にまとめる（FR-610、ADR-0033）

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::board::{self, BoardId, Replaced};
use crate::category::{self, Failed};
use crate::library::{err, Library};
use crate::trash;

#[derive(Debug, Default, Serialize)]
pub struct Merged {
    /// ゴミ箱へ移した画像
    pub trashed: Vec<i64>,
    /// ゴミ箱へ移せなかった画像。ファイルも DB も元のまま
    pub failed: Vec<Failed>,
    pub replaced: Vec<Replaced>,
    /// 配置を置き換えたボード
    pub boards: Vec<BoardId>,
}

// SQL の IN に id の列を1つのパラメーターで渡すため、JSON の配列にして json_each で開く
fn json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap()
}

/// keep の画像を残し、remove の画像をゴミ箱へ移す。keep のカテゴリを category（None は未分類）にし、
/// タグを tags にする。keep に元URLがなければ remove の画像のものを引き継ぐ。ゴミ箱へ移した画像のボードの配置は
/// keep に置き換える。メモは引き継がない。
/// カテゴリ → ゴミ箱 → DB の順に行う。カテゴリを移せなければ何もせずに止める。ゴミ箱へ移せない画像は
/// 元のまま failed に入れ、配置も置き換えない。最後のタグ・元URL・配置は1つのトランザクションで書き、
/// 失敗すればそれだけを戻す。ゴミ箱の画像は自分のタグと元URLを持ったまま戻せるので、どこで止まっても画像を失わない
pub fn merge(
    lib: &mut Library,
    keep: i64,
    remove: &[i64],
    category: Option<i64>,
    tags: &[i64],
) -> Result<Merged, String> {
    check(lib, keep, remove)?;
    let now: Option<i64> = lib
        .conn
        .query_row(
            "SELECT category_id FROM images WHERE id = ?1",
            [keep],
            |r| r.get(0),
        )
        .map_err(err)?;
    if now != category {
        if let Some(f) = category::assign(lib, &[keep], category)?.failed.pop() {
            return Err(format!(
                "残す画像のカテゴリを変えられません（{}）",
                f.message
            ));
        }
    }
    let done = trash::trash(lib, remove)?;
    let mut out = Merged {
        trashed: done.done,
        failed: done.failed,
        ..Merged::default()
    };
    let tx = lib.conn.transaction().map_err(err)?;
    tx.execute("DELETE FROM image_tags WHERE image_id = ?1", [keep])
        .map_err(err)?;
    tx.execute(
        "INSERT INTO image_tags(image_id, tag_id)
         SELECT ?1, id FROM tags WHERE id IN (SELECT value FROM json_each(?2))",
        params![keep, json(tags)],
    )
    .map_err(err)?;
    // 残す画像の初期値と同じ順で、元URLのある画像を選ぶ
    tx.execute(
        "INSERT INTO image_sources(image_id, image_url, page_url, fetched_at)
         SELECT ?1, s.image_url, s.page_url, s.fetched_at
         FROM image_sources s JOIN images i ON i.id = s.image_id
         WHERE s.image_id IN (SELECT value FROM json_each(?2))
           AND NOT EXISTS (SELECT 1 FROM image_sources WHERE image_id = ?1)
         ORDER BY i.width * i.height DESC, i.file_size DESC, i.imported_at, i.id LIMIT 1",
        params![keep, json(remove)],
    )
    .map_err(err)?;
    for &id in &out.trashed {
        if let Some((replaced, boards)) = board::replace_image(&tx, id, keep)? {
            out.replaced.push(replaced);
            for b in boards {
                if !out.boards.contains(&b) {
                    out.boards.push(b);
                }
            }
        }
    }
    tx.commit().map_err(|e| {
        format!("ゴミ箱へ移しましたが、タグ・元URL・ボードの配置を引き継げません（{e}）")
    })?;
    board::end_edit(lib, &out.boards);
    Ok(out)
}

/// 選んだ画像がすべてあり、ゴミ箱にも「見つからない」にもないこと
fn check(lib: &Library, keep: i64, remove: &[i64]) -> Result<(), String> {
    if remove.is_empty() || remove.contains(&keep) {
        return Err("残す画像と、ゴミ箱へ移す画像を選んでください".into());
    }
    for &id in std::iter::once(&keep).chain(remove) {
        let ok = lib
            .conn
            .query_row(
                "SELECT 1 FROM images WHERE id = ?1 AND deleted_at IS NULL AND missing_at IS NULL",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(err)?;
        if ok.is_none() {
            return Err(format!(
                "ゴミ箱と見つからない画像はまとめられません（{id}）"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;
    use crate::board::{
        create, load, session, sources, Crop, Geometry, ItemDraft, Snapshot, Viewport,
    };
    use crate::category::create as create_category;
    use crate::category::tests::{files, lock, pending, put, read, row, setup, unlock};
    use crate::library::TRASH_DIR;

    /// 幅・高さ・ファイルサイズ・取り込み日時を決めた画像
    fn image(lib: &Library, name: &str, size: (i64, i64), bytes: i64, imported: i64) -> i64 {
        let id = put(lib, None, name, name);
        lib.conn
            .execute(
                "UPDATE images SET width = ?1, height = ?2, file_size = ?3, imported_at = ?4,
                 memo = ?5 WHERE id = ?6",
                params![size.0, size.1, bytes, imported, format!("{name}のメモ"), id],
            )
            .unwrap();
        id
    }

    fn tag(lib: &Library, name: &str, ids: &[i64]) -> i64 {
        lib.conn
            .execute("INSERT INTO tags(name) VALUES (?1)", [name])
            .unwrap();
        let tag = lib.conn.last_insert_rowid();
        for id in ids {
            lib.conn
                .execute("INSERT INTO image_tags VALUES (?1, ?2)", [id, &tag])
                .unwrap();
        }
        tag
    }

    fn tags(lib: &Library, id: i64) -> Vec<i64> {
        let mut stmt = lib
            .conn
            .prepare("SELECT tag_id FROM image_tags WHERE image_id = ?1 ORDER BY tag_id")
            .unwrap();
        let tags = stmt
            .query_map([id], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        tags
    }

    fn url(lib: &Library, id: i64, url: &str) {
        lib.conn
            .execute(
                "INSERT INTO image_sources VALUES (?1, ?2, NULL, 1)",
                params![id, url],
            )
            .unwrap();
    }

    fn url_of(lib: &Library, id: i64) -> Option<String> {
        lib.conn
            .query_row(
                "SELECT image_url FROM image_sources WHERE image_id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
    }

    fn memo(lib: &Library, id: i64) -> String {
        lib.conn
            .query_row("SELECT memo FROM images WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    fn trashed(lib: &Library, id: i64) -> bool {
        lib.conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM images WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn cropped() -> Geometry {
        Geometry {
            width: 100.0,
            height: 50.0,
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 90.0,
            flipped: true,
            grayscale: true,
            crop: Some(Crop {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            }),
            stack_order: 3,
        }
    }

    /// image を geometry で置いたボード
    fn placed(lib: &mut Library, name: &str, image: i64, geometry: Geometry) -> BoardId {
        let s = session(lib);
        let source = sources(lib, s, &[image]).unwrap().remove(0);
        let snapshot = Snapshot {
            viewport: Viewport::default(),
            items: vec![ItemDraft {
                id: None,
                source_id: source.id,
                geometry,
            }],
        };
        create(lib, s, name, &snapshot).unwrap().board.id
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn 二枚をまとめると一枚が残りほかはゴミ箱へ移りタグは指定のとおりになりメモは引き継がない() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (200, 100), 10, 1);
        let other = image(&lib, "b.jpg", (100, 50), 10, 1);
        let mine = tag(&lib, "残す方", &[keep]);
        let theirs = tag(&lib, "移す方", &[other]);
        let dropped = tag(&lib, "外す", &[keep, other]);

        let r = merge(&mut lib, keep, &[other], None, &[mine, theirs]).unwrap();

        assert_eq!(r.trashed, [other]);
        assert!(r.failed.is_empty() && r.replaced.is_empty() && r.boards.is_empty());
        assert_eq!(files(&lib, "_未分類"), ["a.jpg"]);
        assert_eq!(files(&lib, TRASH_DIR), [format!("{other}.jpg")]);
        assert_eq!(tags(&lib, keep), [mine, theirs]);
        assert_eq!(
            tags(&lib, other),
            [theirs, dropped],
            "ゴミ箱の画像は自分のタグを持つ"
        );
        assert_eq!(memo(&lib, keep), "a.jpgのメモ");
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn 三枚以上をまとめ元urlがなければ初期値と同じ順の一枚目の元urlを引き継ぐ() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "keep.jpg", (10, 10), 1, 1);
        let small = image(&lib, "small.jpg", (100, 100), 99, 1);
        let old = image(&lib, "old.jpg", (100, 200), 50, 1);
        let new = image(&lib, "new.jpg", (100, 200), 50, 2);
        let heavy = image(&lib, "heavy.jpg", (200, 100), 60, 3);
        let bare = image(&lib, "bare.jpg", (1000, 1000), 1, 1);
        for (id, u) in [(small, "s"), (old, "o"), (new, "n"), (heavy, "h")] {
            url(&lib, id, &format!("https://example.com/{u}"));
        }

        let r = merge(&mut lib, keep, &[small, old, new, heavy, bare], None, &[]).unwrap();

        assert_eq!(r.trashed, [small, old, new, heavy, bare]);
        assert_eq!(url_of(&lib, keep).as_deref(), Some("https://example.com/h"));
        assert_eq!(
            url_of(&lib, heavy).as_deref(),
            Some("https://example.com/h")
        );
        assert_eq!(files(&lib, "_未分類"), ["keep.jpg"]);
    }

    #[test]
    fn 残す画像に元urlがあればそのままにする() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);
        url(&lib, keep, "https://example.com/keep");
        url(&lib, other, "https://example.com/other");

        merge(&mut lib, keep, &[other], None, &[]).unwrap();

        assert_eq!(
            url_of(&lib, keep).as_deref(),
            Some("https://example.com/keep")
        );
    }

    #[test]
    fn 残す画像のカテゴリを変えるとファイルもそのフォルダへ移る() {
        let (_d, mut lib) = setup();
        let pose = create_category(&mut lib, None, "ポーズ").unwrap();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);

        merge(&mut lib, keep, &[other], Some(pose), &[]).unwrap();

        assert_eq!(row(&lib, keep), ("a.jpg".into(), Some(pose)));
        assert_eq!(read(&lib, "ポーズ/a.jpg"), "a.jpg");
        assert!(trashed(&lib, other));
    }

    #[test]
    fn ゴミ箱から戻すと画像とそのタグが戻り残した画像のタグと元urlとボードは変わらない() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (100, 100), 1, 1);
        let other = image(&lib, "b.jpg", (100, 100), 1, 1);
        let theirs = tag(&lib, "移す方", &[other]);
        url(&lib, other, "https://example.com/b");
        let board = placed(&mut lib, "ボード", other, cropped());
        merge(&mut lib, keep, &[other], None, &[theirs]).unwrap();
        let s = session(&lib);
        let before = load(&lib, s, board).unwrap().items;

        let r = trash::restore(&mut lib, &[other]).unwrap();

        assert!(r.failed.is_empty());
        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "b.jpg"]);
        assert_eq!(tags(&lib, other), [theirs]);
        assert_eq!(tags(&lib, keep), [theirs]);
        assert_eq!(url_of(&lib, keep).as_deref(), Some("https://example.com/b"));
        assert_eq!(load(&lib, s, board).unwrap().items, before);
        assert_eq!(before[0].source.image_id, Some(keep));
    }

    #[test]
    fn ゴミ箱へ移した画像の配置を開いていないボードも含めて残す画像に置き換え取り消しの分も直す() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (100, 100), 1, 1);
        let other = image(&lib, "b.jpg", (100, 50), 1, 1);
        let open = placed(&mut lib, "開いている", other, cropped());
        let closed = placed(&mut lib, "閉じている", other, cropped());
        let mut kept = cropped();
        kept.crop = None;
        let untouched = placed(&mut lib, "残す画像だけ", keep, kept.clone());
        let s = session(&lib);
        let editing = board::open(&mut lib, s, open).unwrap();
        // 取り消しの履歴にだけある配置（外した配置）
        let mut moved = editing.board.snapshot();
        moved.items.clear();
        let saved =
            board::save(&mut lib, editing.edit, editing.board.revision + 1, &moved).unwrap();
        let mut restored = editing.board.snapshot();
        restored.items[0].geometry.x = 5.0;

        let r = merge(&mut lib, keep, &[other], None, &[]).unwrap();

        assert_eq!(r.boards, [open, closed]);
        assert_eq!(r.replaced.len(), 1);
        assert_eq!(r.replaced[0].to.image_id, Some(keep));
        assert!(
            board::save(&mut lib, editing.edit, saved.board.revision + 1, &moved).is_err(),
            "開いているボードの編集は終える"
        );
        let item = load(&lib, s, closed).unwrap().items.remove(0);
        assert_eq!(item.source.image_id, Some(keep));
        assert_eq!(item.geometry, board::replaced(&cropped(), 100.0, 100.0));
        assert!(load(&lib, s, open).unwrap().items.is_empty());
        // 開き直したボードで、履歴から外した配置を戻して保存できる
        let reopened = board::open(&mut lib, s, open).unwrap();
        assert!(reopened.board.revision > saved.board.revision);
        restored.items[0].source_id = r.replaced[0].to.id;
        let back = board::save(
            &mut lib,
            reopened.edit,
            reopened.board.revision + 1,
            &restored,
        )
        .unwrap();
        assert_eq!(back.board.items[0].source.image_id, Some(keep));
        assert_eq!(load(&lib, s, untouched).unwrap().items[0].geometry, kept);
    }

    #[test]
    fn 置き換えは見えている部分の中心と表示の幅を保ちトリミングを外し加工を保つ() {
        let plain = Geometry {
            width: 640.0,
            height: 480.0,
            scale: 0.5,
            rotation: 0.0,
            flipped: false,
            crop: None,
            ..cropped()
        };
        let g = board::replaced(&plain, 320.0, 320.0);
        (close(g.scale, 1.0), close(g.x, 0.0), close(g.y, -40.0));
        assert_eq!((g.width, g.height, g.crop), (320.0, 320.0, None));

        // 右半分を切り抜いて左右反転すると、見えているのは枠の左半分
        let flat = Geometry {
            rotation: 0.0,
            ..cropped()
        };
        let g = board::replaced(&flat, 100.0, 100.0);
        (close(g.scale, 0.5), close(g.x, 0.0), close(g.y, 0.0));

        // 枠の中心 (50, 25) で90度回すと、見えている部分の中心 (25, 25) は (50, 0) に来る
        let g = board::replaced(&cropped(), 100.0, 100.0);
        (close(g.scale, 0.5), close(g.x, 25.0), close(g.y, -25.0));
        assert_eq!(
            (g.rotation, g.flipped, g.grayscale, g.stack_order),
            (90.0, true, true, 3)
        );
    }

    #[test]
    fn ゴミ箱へ移せない画像は元のままにして配置も置き換えず残りをまとめる() {
        let (_d, mut lib) = setup();
        let locked = create_category(&mut lib, None, "鍵付き").unwrap();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);
        let stuck = put(&lib, Some(locked), "stuck.jpg", "S");
        let board = placed(&mut lib, "ボード", stuck, cropped());
        let dir = lib.root.join("鍵付き");
        if !lock(&dir) {
            return;
        }

        let r = merge(&mut lib, keep, &[stuck, other], None, &[]);

        unlock(&dir);
        let r = r.unwrap();
        assert_eq!(r.trashed, [other]);
        assert_eq!(r.failed.iter().map(|f| f.id).collect::<Vec<_>>(), [stuck]);
        assert!(r.boards.is_empty());
        assert_eq!(files(&lib, "鍵付き"), ["stuck.jpg"]);
        assert!(!trashed(&lib, stuck));
        let s = session(&lib);
        assert_eq!(
            load(&lib, s, board).unwrap().items[0].source.image_id,
            Some(stuck)
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn dbの書き込みが途中で失敗するとタグと元urlと配置を戻しゴミ箱の画像は戻せる() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);
        let mine = tag(&lib, "残す方", &[keep]);
        let theirs = tag(&lib, "移す方", &[other]);
        url(&lib, other, "https://example.com/b");
        let board = placed(&mut lib, "ボード", other, cropped());
        let s = session(&lib);
        let before = load(&lib, s, board).unwrap();
        lib.conn
            .execute_batch(
                "CREATE TRIGGER fail_item BEFORE UPDATE ON board_items
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
            )
            .unwrap();

        let e = merge(&mut lib, keep, &[other], None, &[theirs]).unwrap_err();

        assert!(e.contains("injected write failure"), "{e}");
        assert_eq!(tags(&lib, keep), [mine]);
        assert_eq!(url_of(&lib, keep), None);
        assert_eq!(load(&lib, s, board).unwrap(), {
            let mut b = before.clone();
            b.items[0].source.status = board::SourceStatus::Trashed;
            b
        });
        assert!(trashed(&lib, other));
        trash::restore(&mut lib, &[other]).unwrap();
        assert_eq!(read(&lib, "_未分類/b.jpg"), "b.jpg");
        assert_eq!(tags(&lib, other), [theirs]);
        assert_eq!(
            url_of(&lib, other).as_deref(),
            Some("https://example.com/b")
        );
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn カテゴリを移せなければゴミ箱へ移さずに止める() {
        let (_d, mut lib) = setup();
        let locked = create_category(&mut lib, None, "鍵付き").unwrap();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);
        let dir = lib.root.join("鍵付き");
        if !lock(&dir) {
            return;
        }

        let r = merge(&mut lib, keep, &[other], Some(locked), &[]);

        unlock(&dir);
        assert!(r.is_err());
        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "b.jpg"]);
        assert!(!trashed(&lib, other));
        assert_eq!(pending(&lib), 0);
    }

    #[test]
    fn ゴミ箱と見つからない画像と残す画像だけの選択ではまとめない() {
        let (_d, mut lib) = setup();
        let keep = image(&lib, "a.jpg", (1, 1), 1, 1);
        let gone = image(&lib, "gone.jpg", (1, 1), 1, 1);
        let binned = image(&lib, "binned.jpg", (1, 1), 1, 1);
        let other = image(&lib, "b.jpg", (1, 1), 1, 1);
        lib.conn
            .execute("UPDATE images SET missing_at = 1 WHERE id = ?1", [gone])
            .unwrap();
        trash::trash(&mut lib, &[binned]).unwrap();

        for (k, rm) in [
            (keep, vec![]),
            (keep, vec![keep]),
            (keep, vec![other, gone]),
            (keep, vec![binned]),
            (gone, vec![other]),
            (keep, vec![999]),
        ] {
            assert!(merge(&mut lib, k, &rm, None, &[]).is_err(), "{k} {rm:?}");
        }
        assert_eq!(files(&lib, "_未分類"), ["a.jpg", "b.jpg", "gone.jpg"]);
    }
}
