use std::fs;
use std::sync::Mutex;

use super::*;
use crate::category::tests::{lock, put, setup, unlock};
use crate::library::{self, Access, KURA_DIR};

fn empty() -> Snapshot {
    Snapshot {
        viewport: Viewport::default(),
        items: vec![],
    }
}

fn geometry() -> Geometry {
    Geometry {
        width: 640.0,
        height: 480.0,
        x: -15.5,
        y: 27.25,
        scale: 0.75,
        rotation: 123.5,
        flipped: true,
        grayscale: true,
        crop: Some(Crop {
            x: 0.125,
            y: 0.25,
            width: 0.5,
            height: 0.625,
        }),
        stack_order: 7,
    }
}

fn snapshot(lib: &Library, image_id: i64) -> Snapshot {
    let source = sources(lib, session(lib), &[image_id]).unwrap().remove(0);
    Snapshot {
        viewport: Viewport {
            x: 125.5,
            y: -83.25,
            scale: 1.25,
        },
        items: vec![ItemDraft {
            id: None,
            source_id: source.id,
            geometry: geometry(),
        }],
    }
}

#[test]
fn 名前は前後を除いてnfcにそろえ記号と100文字を許す() {
    let (_dir, mut lib) = setup();
    let s = session(&lib);
    let board = create(&mut lib, s, "  Cafe\u{301} / : ? *  ", &empty()).unwrap();
    assert_eq!(board.board.name, "Café / : ? *");
    assert!(create(&mut lib, s, "café / : ? *", &empty()).is_err());
    assert!(create(&mut lib, s, " \t\n", &empty()).is_err());
    let boundary = "😀".repeat(100);
    let second = create(&mut lib, s, &boundary, &empty()).unwrap();
    assert_eq!(second.board.name.chars().count(), 100);
    assert!(create(&mut lib, s, &"字".repeat(101), &empty()).is_err());
    let renamed = rename(&mut lib, s, board.board.id, "CAFÉ / : ? *").unwrap();
    assert_eq!(renamed.name, "CAFÉ / : ? *");
    assert!(rename(&mut lib, s, second.board.id, "cafe\u{301} / : ? *").is_err());
    assert!(rename(&mut lib, s, second.board.id, "").is_err());
    assert!(rename(&mut lib, s, BoardId(999), "なし").is_err());
    assert_eq!(list(&lib, s).unwrap().boards.len(), 2);
}

#[test]
fn 同じ画像を別の配置として保存し全加工と視点を復元する() {
    let (dir, mut lib) = setup();
    let image = put(&lib, None, "参考.png", "元画像の内容");
    let s = session(&lib);
    let mut draft = snapshot(&lib, image);
    let mut second = draft.items[0].clone();
    second.geometry.x = 555.0;
    second.geometry.flipped = false;
    second.geometry.crop = None;
    second.geometry.stack_order = 8;
    draft.items.push(second);
    let created = create(&mut lib, s, "構図", &draft).unwrap();
    let board = &created.board;
    assert_ne!(board.items[0].id, board.items[1].id);
    assert_eq!(board.items[0].source.id, board.items[1].source.id);
    assert_eq!(board.items[0].geometry, draft.items[0].geometry);
    assert_eq!(board.items[1].geometry, draft.items[1].geometry);
    assert_eq!(board.viewport, draft.viewport);
    assert_eq!(list(&lib, s).unwrap().boards[0].placement_count, 2);
    assert_eq!(last(&lib, s).unwrap(), Some(board.clone()));
    assert_eq!(
        fs::read_to_string(dir.path().join("_未分類/参考.png")).unwrap(),
        "元画像の内容"
    );
    let saved = save(&mut lib, created.edit, 1, &board.snapshot()).unwrap();
    assert_eq!(saved.board.items, board.items);
    drop(lib);
    let lib = library::open(dir.path()).unwrap();
    assert_eq!(last(&lib, session(&lib)).unwrap(), Some(saved.board));
}

#[test]
fn 配置削除とundoは同じidを保ち元画像も別の配置も変えない() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "画像");
    let s = session(&lib);
    let mut draft = snapshot(&lib, image);
    draft.items.push(draft.items[0].clone());
    let created = create(&mut lib, s, "並べる", &draft).unwrap();
    let before = created.board.snapshot();
    let mut removed = before.clone();
    removed.items.remove(0);
    let after = save(&mut lib, created.edit, 1, &removed).unwrap();
    assert_eq!(after.board.items.len(), 1);
    assert_eq!(after.board.items[0], created.board.items[1]);
    let undone = save(&mut lib, created.edit, 2, &before).unwrap();
    assert_eq!(undone.board.items, created.board.items);
    assert_eq!(
        lib.conn
            .query_row("SELECT count(*) FROM images", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn 配置の重複idと別ボードのidと元画像の差し替えを拒否して全体を残す() {
    let (_dir, mut lib) = setup();
    let a = put(&lib, None, "a.png", "a");
    let b = put(&lib, None, "b.png", "b");
    let s = session(&lib);
    let a_draft = snapshot(&lib, a);
    let b_draft = snapshot(&lib, b);
    let created = create(&mut lib, s, "A", &a_draft).unwrap();
    let other = create(&mut lib, s, "B", &b_draft).unwrap();
    let opened = open(&mut lib, s, created.board.id).unwrap();
    let before = opened.board.clone();
    let mut invalid = before.snapshot();
    invalid.items.push(invalid.items[0].clone());
    assert!(save(&mut lib, opened.edit, 1, &invalid).is_err());
    invalid = before.snapshot();
    invalid.items[0].id = Some(other.board.items[0].id);
    assert!(save(&mut lib, opened.edit, 1, &invalid).is_err());
    invalid = before.snapshot();
    invalid.items[0].source_id = other.board.items[0].source.id;
    assert!(save(&mut lib, opened.edit, 1, &invalid).is_err());
    invalid.items[0].id = Some(PlacementId(999));
    assert!(save(&mut lib, opened.edit, 1, &invalid).is_err());
    assert_eq!(load(&lib, s, before.id).unwrap(), before);
}

#[test]
fn 無限値と非正寸法と範囲外cropを保存しない() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "画像");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "検査", &draft).unwrap();
    let mut invalids = vec![];
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut v = created.board.snapshot();
        v.viewport.x = value;
        invalids.push(v);
        let mut v = created.board.snapshot();
        v.items[0].geometry.rotation = value;
        invalids.push(v);
    }
    for value in [0.0, -1.0, f64::INFINITY] {
        let mut v = created.board.snapshot();
        v.items[0].geometry.width = value;
        invalids.push(v);
        let mut v = created.board.snapshot();
        v.items[0].geometry.height = value;
        invalids.push(v);
        let mut v = created.board.snapshot();
        v.items[0].geometry.scale = value;
        invalids.push(v);
        let mut v = created.board.snapshot();
        v.viewport.scale = value;
        invalids.push(v);
    }
    for crop in [
        Crop {
            x: -0.1,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
        Crop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 1.0,
        },
        Crop {
            x: 0.5,
            y: 0.5,
            width: 0.6,
            height: 0.6,
        },
        Crop {
            x: 0.0,
            y: f64::NAN,
            width: 1.0,
            height: 1.0,
        },
    ] {
        let mut v = created.board.snapshot();
        v.items[0].geometry.crop = Some(crop);
        invalids.push(v);
    }
    for invalid in invalids {
        assert!(save(&mut lib, created.edit, 1, &invalid).is_err());
        assert_eq!(load(&lib, s, created.board.id).unwrap(), created.board);
    }
}

#[test]
fn 名前変更とゴミ箱とmissingと完全削除は同じ参照の状態になる() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "before.png", "画像");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "参照", &draft).unwrap();
    lib.conn
        .execute(
            "UPDATE images SET file_name = 'after.png' WHERE id = ?1",
            [image],
        )
        .unwrap();
    let renamed = load(&lib, s, created.board.id).unwrap();
    assert_eq!(renamed.items[0].source.file_name, "after.png");
    assert_eq!(renamed.items[0].source.status, SourceStatus::Available);
    lib.conn
        .execute("UPDATE images SET missing_at = 1 WHERE id = ?1", [image])
        .unwrap();
    assert_eq!(
        load(&lib, s, created.board.id).unwrap().items[0]
            .source
            .status,
        SourceStatus::Missing
    );
    assert!(sources(&lib, s, &[image]).is_err());
    assert!(save(&mut lib, created.edit, 1, &renamed.snapshot()).is_ok());
    lib.conn
        .execute(
            "UPDATE images SET missing_at = NULL, deleted_at = 1 WHERE id = ?1",
            [image],
        )
        .unwrap();
    assert_eq!(
        load(&lib, s, created.board.id).unwrap().items[0]
            .source
            .status,
        SourceStatus::Trashed
    );
    assert!(sources(&lib, s, &[image]).is_err());
    let mut extra = renamed.snapshot();
    extra.items[0].id = None;
    assert!(save(&mut lib, created.edit, 2, &extra).is_err());
    crate::trash::forget(&mut lib, image).unwrap();
    let deleted = load(&lib, s, created.board.id).unwrap();
    assert_eq!(deleted.items[0].source.image_id, None);
    assert_eq!(deleted.items[0].source.file_name, "after.png");
    assert_eq!(deleted.items[0].source.status, SourceStatus::Deleted);
    assert_eq!(deleted.items[0].geometry, geometry());
}

#[test]
fn 完全削除後のid再利用と同じ内容の再取り込みと古いundoを結び直さない() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "before.png", "同じハッシュ");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "削除前", &draft).unwrap();
    let undo = created.board.snapshot();
    save(&mut lib, created.edit, 1, &empty()).unwrap();
    crate::trash::forget(&mut lib, image).unwrap();
    let reimported = put(&lib, None, "after.png", "同じハッシュ");
    assert_eq!(image, reimported);
    let new_source = sources(&lib, s, &[reimported]).unwrap().remove(0);
    assert_ne!(new_source.id, created.board.items[0].source.id);
    let undone = save(&mut lib, created.edit, 2, &undo).unwrap();
    assert_eq!(undone.board.items[0].source.image_id, None);
    assert_eq!(undone.board.items[0].source.file_name, "before.png");
    assert_eq!(undone.board.items[0].id, created.board.items[0].id);
    let mut rebound = undo;
    rebound.items[0].source_id = new_source.id;
    assert!(save(&mut lib, created.edit, 3, &rebound).is_err());
}

#[test]
fn 失効した編集と逆順のrevisionは保存済みを巻き戻さない() {
    let (_dir, mut lib) = setup();
    let s = session(&lib);
    let created = create(&mut lib, s, "順序", &empty()).unwrap();
    let opened = open(&mut lib, s, created.board.id).unwrap();
    assert_ne!(created.edit.token, opened.edit.token);
    assert!(save(&mut lib, created.edit, 9, &empty()).is_err());
    let mut latest = empty();
    latest.viewport.x = 123.0;
    let saved = save(&mut lib, opened.edit, 3, &latest).unwrap();
    assert_eq!(saved.edit, opened.edit);
    assert_eq!(saved.board.revision, 3);
    assert!(save(&mut lib, opened.edit, 2, &empty()).is_err());
    assert!(save(&mut lib, opened.edit, 3, &empty()).is_err());
    assert_eq!(last(&lib, s).unwrap(), Some(saved.board));
}

#[test]
fn 同じ画像idとボードidがある二つのライブラリをa_b_aと開いても古い要求を拒む() {
    let (a_dir, mut a) = setup();
    let (_b_dir, mut b) = setup();
    let ai = put(&a, None, "a.png", "a");
    let bi = put(&b, None, "b.png", "b");
    assert_eq!(ai, bi);
    let a_s = session(&a);
    let b_s = session(&b);
    let a_draft = snapshot(&a, ai);
    let b_draft = snapshot(&b, bi);
    let old = create(&mut a, a_s, "同名", &a_draft).unwrap();
    let other = create(&mut b, b_s, "同名", &b_draft).unwrap();
    assert_eq!(old.board.id, other.board.id);
    let current = Mutex::new(Some(a));
    *current.lock().unwrap() = Some(b);
    assert!(current
        .with(|lib| save(lib, old.edit, 1, &empty()))
        .is_err());
    *current.lock().unwrap() = Some(library::open(a_dir.path()).unwrap());
    assert!(current
        .with(|lib| save(lib, old.edit, 2, &empty()))
        .is_err());
    current
        .with(|lib| {
            let s = session(lib);
            assert_ne!(s, a_s);
            assert!(delete(lib, a_s, old.board.id).is_err());
            assert!(rename(lib, a_s, old.board.id, "遅延").is_err());
            assert!(create(lib, a_s, "遅延", &empty()).is_err());
            assert_eq!(load(lib, s, old.board.id)?, old.board);
            Ok(())
        })
        .unwrap();
}

#[test]
fn ボード削除は配置だけ消し最後のボードを空にしてidを再利用しない() {
    let (dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "残す");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let first = create(&mut lib, s, "1", &draft).unwrap();
    let second = create(&mut lib, s, "2", &draft).unwrap();
    delete(&mut lib, s, first.board.id).unwrap();
    assert_eq!(last(&lib, s).unwrap(), Some(second.board.clone()));
    delete(&mut lib, s, second.board.id).unwrap();
    assert_eq!(last(&lib, s).unwrap(), None);
    assert!(list(&lib, s).unwrap().boards.is_empty());
    assert!(save(&mut lib, second.edit, 1, &second.board.snapshot()).is_err());
    assert_eq!(
        lib.conn
            .query_row("SELECT count(*) FROM board_items", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("_未分類/画像.png")).unwrap(),
        "残す"
    );
    let third = create(&mut lib, s, "3", &draft).unwrap();
    assert!(third.board.id.0 > second.board.id.0);
    assert!(third.board.items[0].id.0 > second.board.items[0].id.0);
}

#[test]
fn sqlの途中失敗は配置と視点とrevisionと最後のボードを一緒に戻す() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "画像");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "失敗", &draft).unwrap();
    lib.conn.execute_batch("CREATE TRIGGER fail_item BEFORE INSERT ON board_items BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
    let mut changed = created.board.snapshot();
    changed.viewport.x = 999.0;
    changed.items[0].geometry.x = 456.0;
    let mut additional = changed.items[0].clone();
    additional.id = None;
    changed.items.push(additional);
    assert!(save(&mut lib, created.edit, 1, &changed)
        .unwrap_err()
        .contains("injected write failure"));
    assert_eq!(load(&lib, s, created.board.id).unwrap(), created.board);
    assert!(create(&mut lib, s, "半端", &draft).is_err());
    assert_eq!(list(&lib, s).unwrap().boards.len(), 1);
    assert_eq!(last(&lib, s).unwrap(), Some(created.board.clone()));
    lib.conn.execute_batch("DROP TRIGGER fail_item").unwrap();
    assert!(save(&mut lib, created.edit, 1, &changed).is_ok());
}

#[test]
fn 読み取り専用dbの実際の保存エラーで配置を残しロック解除後に再試行できる() {
    let (dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "画像");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "保存済み", &draft).unwrap();
    let kura = dir.path().join(KURA_DIR);
    let db = kura.join("kura.db");
    if !lock(&kura) {
        return;
    }
    lib.conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let before = load(&lib, s, created.board.id).unwrap();
    let mut changed = before.snapshot();
    changed.viewport.x = 321.0;
    let r = save(&mut lib, created.edit, 1, &changed);
    unlock(&kura);
    let error = r.unwrap_err();
    assert!(
        error.contains("readonly"),
        "実際のSQLite書き込みエラーを確認する（{error}）"
    );
    assert_eq!(load(&lib, s, before.id).unwrap(), before);
    drop(lib);
    let mut lib = library::open(dir.path()).unwrap();
    let s = session(&lib);
    let edit = open(&mut lib, s, before.id).unwrap();
    let mut changed = edit.board.snapshot();
    changed.viewport.x = 321.0;
    assert_eq!(
        save(&mut lib, edit.edit, 1, &changed)
            .unwrap()
            .board
            .viewport
            .x,
        321.0
    );
}

#[test]
fn バックアップの復元で配置と削除参照とundo用idと最後のボードが残る() {
    let (dir, mut lib) = setup();
    let image = put(&lib, None, "残す名前.png", "同じ画像");
    let s = session(&lib);
    let mut draft = snapshot(&lib, image);
    draft.items.push(draft.items[0].clone());
    let created = create(&mut lib, s, "バックアップ", &draft).unwrap();
    let undo = created.board.snapshot();
    let mut one = undo.clone();
    one.items.remove(0);
    save(&mut lib, created.edit, 1, &one).unwrap();
    crate::trash::forget(&mut lib, image).unwrap();
    let before = load(&lib, s, created.board.id).unwrap();
    let out = tempfile::tempdir().unwrap();
    let backup = out.path().join("boards.db");
    library::backup(&lib, &backup).unwrap();
    delete(&mut lib, s, created.board.id).unwrap();
    create(&mut lib, s, "書き出した後", &empty()).unwrap();
    drop(lib);
    for name in ["kura.db", "kura.db-wal", "kura.db-shm"] {
        let _ = fs::remove_file(dir.path().join(KURA_DIR).join(name));
    }
    fs::copy(&backup, dir.path().join(KURA_DIR).join("kura.db")).unwrap();
    let mut lib = library::open(dir.path()).unwrap();
    let s = session(&lib);
    assert_eq!(last(&lib, s).unwrap(), Some(before.clone()));
    assert_eq!(list(&lib, s).unwrap().boards[0].placement_count, 1);
    assert_eq!(before.items[0].source.status, SourceStatus::Deleted);
    assert_eq!(before.items[0].source.file_name, "残す名前.png");
    let opened = open(&mut lib, s, before.id).unwrap();
    let undone = save(&mut lib, opened.edit, 2, &undo).unwrap();
    assert_eq!(undone.board.items.len(), 2);
    assert_eq!(undone.board.items[0].id, created.board.items[0].id);
    assert_eq!(
        undone.board.items[0].source.id,
        created.board.items[0].source.id
    );
    assert_eq!(undone.board.items[0].source.image_id, None);
    let reimported = put(&lib, None, "再取り込み.png", "同じ画像");
    assert_eq!(reimported, image);
    assert_ne!(
        sources(&lib, s, &[reimported]).unwrap()[0].id,
        before.items[0].source.id
    );
}

#[test]
fn 名前変更とボード削除のsql失敗は名前と配置と最後のボードを残す() {
    let (_dir, mut lib) = setup();
    let image = put(&lib, None, "画像.png", "画像");
    let s = session(&lib);
    let draft = snapshot(&lib, image);
    let created = create(&mut lib, s, "元の名前", &draft).unwrap();
    lib.conn
        .execute_batch(
            "CREATE TRIGGER fail_rename BEFORE UPDATE OF name ON boards BEGIN
             SELECT RAISE(ABORT, 'rename failure'); END;
         CREATE TRIGGER fail_delete BEFORE DELETE ON boards BEGIN
             SELECT RAISE(ABORT, 'delete failure'); END;",
        )
        .unwrap();
    assert!(rename(&mut lib, s, created.board.id, "次の名前")
        .unwrap_err()
        .contains("rename failure"));
    assert!(delete(&mut lib, s, created.board.id)
        .unwrap_err()
        .contains("delete failure"));
    assert_eq!(last(&lib, s).unwrap(), Some(created.board.clone()));
    assert_eq!(list(&lib, s).unwrap().boards[0].placement_count, 1);
    lib.conn
        .execute_batch("DROP TRIGGER fail_rename; DROP TRIGGER fail_delete")
        .unwrap();
    assert!(save(&mut lib, created.edit, 1, &created.board.snapshot()).is_ok());
}
