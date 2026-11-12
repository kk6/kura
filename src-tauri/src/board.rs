//! ライブラリの中に置くボードの保存。`Access::with` から呼ぶ。開いたライブラリのトークンの検査と
//! DB への書き込みを同じ Current のロックの中で行い、切り替えの途中で別のライブラリへ書かないため

use std::collections::HashSet;
use std::ffi::OsStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::fileops;
use crate::library::{err, Library};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BoardId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlacementId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceId(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LibrarySession(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EditToken(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edit {
    pub library_session: LibrarySession,
    pub board_id: BoardId,
    pub token: EditToken,
}

pub(crate) struct Session {
    id: LibrarySession,
    editing: Option<(Edit, u64)>,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

fn token() -> u64 {
    NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
}

impl Session {
    pub(crate) fn new() -> Self {
        Self {
            id: LibrarySession(token()),
            editing: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
        }
    }
}

/// 元画像に対する0〜1の範囲。反転と回転の前の向きで持ち、加工を変えても切り抜く場所がずれないようにする
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub flipped: bool,
    pub grayscale: bool,
    pub crop: Option<Crop>,
    pub stack_order: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    Available,
    Trashed,
    Missing,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Source {
    pub id: SourceId,
    pub image_id: Option<i64>,
    pub file_name: String,
    pub width: i64,
    pub height: i64,
    pub status: SourceStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Item {
    pub id: PlacementId,
    pub source: Source,
    pub geometry: Geometry,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemDraft {
    /// None なら新しい配置として採番する。返った ID を以後の保存と Undo で使い続け、同じ配置として扱う
    pub id: Option<PlacementId>,
    pub source_id: SourceId,
    pub geometry: Geometry,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub viewport: Viewport,
    pub items: Vec<ItemDraft>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Board {
    pub id: BoardId,
    pub name: String,
    pub viewport: Viewport,
    pub updated_at: i64,
    pub revision: u64,
    pub items: Vec<Item>,
}

impl Board {
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            viewport: self.viewport,
            items: self
                .items
                .iter()
                .map(|item| ItemDraft {
                    id: Some(item.id),
                    source_id: item.source.id,
                    geometry: item.geometry.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Summary {
    pub id: BoardId,
    pub name: String,
    pub placement_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct List {
    pub boards: Vec<Summary>,
    pub last_board_id: Option<BoardId>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct EditingBoard {
    pub edit: Edit,
    pub board: Board,
}

pub fn session(lib: &Library) -> LibrarySession {
    lib.board_session.id
}

fn check_session(lib: &Library, expected: LibrarySession) -> Result<(), String> {
    if session(lib) != expected {
        return Err("ライブラリが切り替わったため、ボードの操作を中止しました".into());
    }
    Ok(())
}

pub fn list(lib: &Library, expected: LibrarySession) -> Result<List, String> {
    check_session(lib, expected)?;
    let boards = lib
        .conn
        .prepare(
            "SELECT b.id, b.name, (SELECT count(*) FROM board_items i
             WHERE i.board_id = b.id AND i.active = 1), b.updated_at
             FROM boards b ORDER BY b.updated_at DESC, b.id DESC",
        )
        .map_err(err)?
        .query_map([], |r| {
            Ok(Summary {
                id: BoardId(r.get(0)?),
                name: r.get(1)?,
                placement_count: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(List {
        boards,
        last_board_id: last_id(&lib.conn)?,
    })
}

fn last_id(conn: &Connection) -> Result<Option<BoardId>, String> {
    conn.query_row(
        "SELECT last_board_id FROM board_state WHERE id = 1",
        [],
        |r| Ok(r.get::<_, Option<i64>>(0)?.map(BoardId)),
    )
    .map_err(err)
}

pub fn last(lib: &Library, expected: LibrarySession) -> Result<Option<Board>, String> {
    check_session(lib, expected)?;
    last_id(&lib.conn)?
        .map(|id| load_from(&lib.conn, id))
        .transpose()
}

pub fn load(lib: &Library, expected: LibrarySession, id: BoardId) -> Result<Board, String> {
    check_session(lib, expected)?;
    load_from(&lib.conn, id)
}

fn load_from(conn: &Connection, id: BoardId) -> Result<Board, String> {
    let mut board = conn
        .query_row(
            "SELECT name, viewport_x, viewport_y, viewport_scale, updated_at, revision
             FROM boards WHERE id = ?1",
            [id.0],
            |r| {
                Ok(Board {
                    id,
                    name: r.get(0)?,
                    viewport: Viewport {
                        x: r.get(1)?,
                        y: r.get(2)?,
                        scale: r.get(3)?,
                    },
                    updated_at: r.get(4)?,
                    revision: r.get::<_, i64>(5)? as u64,
                    items: vec![],
                })
            },
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| missing(id))?;
    let rows = conn
        .prepare(
            "SELECT id, source_id, width, height, x, y, scale, rotation, flipped, grayscale,
                    crop_x, crop_y, crop_width, crop_height, stack_order
             FROM board_items WHERE board_id = ?1 AND active = 1 ORDER BY stack_order, id",
        )
        .map_err(err)?
        .query_map([id.0], |r| {
            Ok((
                PlacementId(r.get(0)?),
                SourceId(r.get(1)?),
                Geometry {
                    width: r.get(2)?,
                    height: r.get(3)?,
                    x: r.get(4)?,
                    y: r.get(5)?,
                    scale: r.get(6)?,
                    rotation: r.get(7)?,
                    flipped: r.get(8)?,
                    grayscale: r.get(9)?,
                    crop: match r.get::<_, Option<f64>>(10)? {
                        Some(x) => Some(Crop {
                            x,
                            y: r.get(11)?,
                            width: r.get(12)?,
                            height: r.get(13)?,
                        }),
                        None => None,
                    },
                    stack_order: r.get(14)?,
                },
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for (id, source_id, geometry) in rows {
        board.items.push(Item {
            id,
            source: source(conn, source_id)?,
            geometry,
        });
    }
    Ok(board)
}

fn source(conn: &Connection, id: SourceId) -> Result<Source, String> {
    conn.query_row(
        "SELECT s.image_id, s.file_name, s.width, s.height, i.deleted_at, i.missing_at
         FROM board_sources s LEFT JOIN images i ON i.id = s.image_id WHERE s.id = ?1",
        [id.0],
        |r| {
            let image_id = r.get::<_, Option<i64>>(0)?;
            let status = if image_id.is_none() {
                SourceStatus::Deleted
            } else if r.get::<_, Option<i64>>(4)?.is_some() {
                SourceStatus::Trashed
            } else if r.get::<_, Option<i64>>(5)?.is_some() {
                SourceStatus::Missing
            } else {
                SourceStatus::Available
            };
            Ok(Source {
                id,
                image_id,
                file_name: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                status,
            })
        },
    )
    .optional()
    .map_err(err)?
    .ok_or_else(|| format!("ボードの画像参照が見つかりません（{}）", id.0))
}

/// 新しい配置の画像参照は画面から受け取らず DB から引く。ゴミ箱・見つからない画像は追加させない
pub fn sources(
    lib: &Library,
    expected: LibrarySession,
    image_ids: &[i64],
) -> Result<Vec<Source>, String> {
    check_session(lib, expected)?;
    image_ids
        .iter()
        .map(|image_id| {
            let id = lib
                .conn
                .query_row(
                    "SELECT id FROM board_sources WHERE image_id = ?1",
                    [image_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
                .ok_or_else(|| format!("画像が見つかりません（{image_id}）"))?;
            let source = source(&lib.conn, SourceId(id))?;
            available(&source)?;
            Ok(source)
        })
        .collect()
}

/// 開いたままのボードが、ギャラリーでの削除・復元・名前変更の後に元画像の今の状態を引く（FR-104、FR-511）。
/// 編集は終わらせない。取り消しの履歴にある外した配置の分も引けるよう、ボードではなく参照 ID で受ける
pub fn refresh(
    lib: &Library,
    expected: LibrarySession,
    ids: &[SourceId],
) -> Result<Vec<Source>, String> {
    check_session(lib, expected)?;
    ids.iter().map(|id| source(&lib.conn, *id)).collect()
}

fn available(source: &Source) -> Result<(), String> {
    if source.status != SourceStatus::Available {
        return Err("ゴミ箱・見つからない・削除された画像はボードに追加できません".into());
    }
    Ok(())
}

fn missing(id: BoardId) -> String {
    format!("ボードが見つかりません（{}）", id.0)
}

fn name(name: &str) -> Result<(String, String), String> {
    let name: String = name.trim().nfc().collect();
    if !(1..=100).contains(&name.chars().count()) {
        return Err("ボード名は前後の空白を除いて1〜100文字で入力してください".into());
    }
    let key = fileops::key(OsStr::new(&name));
    Ok((name, key))
}

fn unique_name(conn: &Connection, key: &str, except: Option<BoardId>) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM boards WHERE name_key = ?1 AND (?2 IS NULL OR id != ?2))",
            params![key, except.map(|id| id.0)],
            |r| r.get(0),
        )
        .map_err(err)?;
    if exists {
        return Err("同じ名前のボードがあります".into());
    }
    Ok(())
}

fn begin(lib: &mut Library, board: Board) -> EditingBoard {
    let edit = Edit {
        library_session: session(lib),
        board_id: board.id,
        token: EditToken(token()),
    };
    lib.board_session.editing = Some((edit, board.revision));
    EditingBoard { edit, board }
}

/// 作成と初期配置をまとめて確定し、途中で失敗しても空のボードだけを残さない
pub fn create(
    lib: &mut Library,
    expected: LibrarySession,
    input_name: &str,
    snapshot: &Snapshot,
) -> Result<EditingBoard, String> {
    check_session(lib, expected)?;
    validate(snapshot)?;
    let (name, key) = name(input_name)?;
    let tx = lib.conn.transaction().map_err(err)?;
    unique_name(&tx, &key, None)?;
    tx.execute(
        "INSERT INTO boards(name, name_key, updated_at) VALUES (?1, ?2, ?3)",
        params![name, key, crate::import::millis(SystemTime::now())?],
    )
    .map_err(err)?;
    let id = BoardId(tx.last_insert_rowid());
    write_snapshot(&tx, id, 0, snapshot)?;
    tx.execute(
        "UPDATE board_state SET last_board_id = ?1 WHERE id = 1",
        [id.0],
    )
    .map_err(err)?;
    let board = load_from(&tx, id)?;
    tx.commit().map_err(err)?;
    Ok(begin(lib, board))
}

/// 同じボードを開き直しても前の編集トークンを失効させる。前に開いた画面の遅れた保存で上書きさせないため
pub fn open(
    lib: &mut Library,
    expected: LibrarySession,
    id: BoardId,
) -> Result<EditingBoard, String> {
    check_session(lib, expected)?;
    let tx = lib.conn.transaction().map_err(err)?;
    let board = load_from(&tx, id)?;
    tx.execute(
        "UPDATE board_state SET last_board_id = ?1 WHERE id = 1",
        [id.0],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(begin(lib, board))
}

pub fn rename(
    lib: &mut Library,
    expected: LibrarySession,
    id: BoardId,
    input_name: &str,
) -> Result<Summary, String> {
    check_session(lib, expected)?;
    let (name, key) = name(input_name)?;
    let tx = lib.conn.transaction().map_err(err)?;
    unique_name(&tx, &key, Some(id))?;
    let updated_at = crate::import::millis(SystemTime::now())?;
    if tx
        .execute(
            "UPDATE boards SET name = ?1, name_key = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, key, updated_at, id.0],
        )
        .map_err(err)?
        == 0
    {
        return Err(missing(id));
    }
    let placement_count = tx
        .query_row(
            "SELECT count(*) FROM board_items WHERE board_id = ?1 AND active = 1",
            [id.0],
            |r| r.get(0),
        )
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(Summary {
        id,
        name,
        placement_count,
        updated_at,
    })
}

pub fn delete(lib: &mut Library, expected: LibrarySession, id: BoardId) -> Result<(), String> {
    check_session(lib, expected)?;
    let tx = lib.conn.transaction().map_err(err)?;
    tx.execute(
        "UPDATE board_state SET last_board_id = NULL WHERE last_board_id = ?1",
        [id.0],
    )
    .map_err(err)?;
    tx.execute("DELETE FROM board_items WHERE board_id = ?1", [id.0])
        .map_err(err)?;
    if tx
        .execute("DELETE FROM boards WHERE id = ?1", [id.0])
        .map_err(err)?
        == 0
    {
        return Err(missing(id));
    }
    tx.commit().map_err(err)?;
    if lib
        .board_session
        .editing
        .is_some_and(|(edit, _)| edit.board_id == id)
    {
        lib.board_session.editing = None;
    }
    Ok(())
}

/// 「ボードに追加」の追加先。JSON では `{"board": 3}` か `{"new": "名前"}`
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Board(BoardId),
    New(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Added {
    pub board_id: BoardId,
    pub placements: Vec<PlacementId>,
}

/// 追加した画像を収める正方形の枠の辺。ボード上の長さ
const CELL: f64 = 240.0;
const GAP: f64 = 24.0;
/// 既存の配置と追加分の間。追加分のまとまりを見分けやすくするため
const MARGIN: f64 = 96.0;

/// ボードと配置と最後のボードをまとめて確定し、途中で失敗しても半端なボードや配置を残さない（FR-701）。
/// そのボードの編集は終わらせる。画面が持つ配置には追加分がなく、そのまま保存すると追加分を消すため。
/// ボードのウィンドウは開き直して追加分を読む
pub fn add(
    lib: &mut Library,
    expected: LibrarySession,
    target: &Target,
    image_ids: &[i64],
) -> Result<Added, String> {
    if image_ids.is_empty() {
        return Err("ボードに追加する画像を選んでください".into());
    }
    let sources = sources(lib, expected, image_ids)?;
    match target {
        Target::New(name) => {
            let snapshot = Snapshot {
                viewport: Viewport::default(),
                items: place(&[], &sources),
            };
            let created = create(lib, expected, name, &snapshot)?;
            Ok(Added {
                board_id: created.board.id,
                placements: created.board.items.iter().map(|i| i.id).collect(),
            })
        }
        Target::Board(id) => {
            let tx = lib.conn.transaction().map_err(err)?;
            let board = load_from(&tx, *id)?;
            let mut snapshot = board.snapshot();
            snapshot.items.extend(place(&board.items, &sources));
            write_snapshot(&tx, *id, board.revision + 1, &snapshot)?;
            tx.execute(
                "UPDATE board_state SET last_board_id = ?1 WHERE id = 1",
                [id.0],
            )
            .map_err(err)?;
            let before: HashSet<_> = board.items.iter().map(|i| i.id).collect();
            let placements = load_from(&tx, *id)?
                .items
                .iter()
                .map(|i| i.id)
                .filter(|i| !before.contains(i))
                .collect();
            tx.commit().map_err(err)?;
            if lib
                .board_session
                .editing
                .is_some_and(|(edit, _)| edit.board_id == *id)
            {
                lib.board_session.editing = None;
            }
            Ok(Added {
                board_id: *id,
                placements,
            })
        }
    }
}

/// 既存の配置を動かさないよう、追加分はその右に並べる。空のボードでは原点を中心にする（FR-701）
fn place(existing: &[Item], sources: &[Source]) -> Vec<ItemDraft> {
    let columns = (sources.len() as f64).sqrt().ceil() as usize;
    let rows = sources.len().div_ceil(columns);
    let span = |n: usize| n as f64 * CELL + (n.saturating_sub(1)) as f64 * GAP;
    let (left, top) = match bounds(existing) {
        Some((_, top, right, _)) => (right + MARGIN, top),
        None => (-span(columns) / 2.0, -span(rows) / 2.0),
    };
    let order = existing
        .iter()
        .map(|i| i.geometry.stack_order)
        .max()
        .map_or(0, |o| o + 1);
    sources
        .iter()
        .enumerate()
        .map(|(n, s)| {
            let (width, height) = (s.width.max(1) as f64, s.height.max(1) as f64);
            let scale = CELL / width.max(height);
            let cell_x = left + (n % columns) as f64 * (CELL + GAP);
            let cell_y = top + (n / columns) as f64 * (CELL + GAP);
            ItemDraft {
                id: None,
                source_id: s.id,
                geometry: Geometry {
                    width,
                    height,
                    x: cell_x + (CELL - width * scale) / 2.0,
                    y: cell_y + (CELL - height * scale) / 2.0,
                    scale,
                    rotation: 0.0,
                    flipped: false,
                    grayscale: false,
                    crop: None,
                    stack_order: order + n as i64,
                },
            }
        })
        .collect()
}

/// 配置全体の外枠。切り抜きは見ないので、描いた範囲より大きくはなっても小さくはならず、追加分が重ならない
fn bounds(items: &[Item]) -> Option<(f64, f64, f64, f64)> {
    items
        .iter()
        .map(|i| {
            let g = &i.geometry;
            let (w, h) = (g.width * g.scale, g.height * g.scale);
            let (sin, cos) = g.rotation.to_radians().sin_cos();
            let (half_w, half_h) = (
                (w * cos.abs() + h * sin.abs()) / 2.0,
                (w * sin.abs() + h * cos.abs()) / 2.0,
            );
            let (cx, cy) = (g.x + w / 2.0, g.y + h / 2.0);
            (cx - half_w, cy - half_h, cx + half_w, cy + half_h)
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))
}

/// revision は同じ編集トークンの中で増やす。失敗した保存は revision を使わず、同じ値で再試行できる。
/// 成功の応答に編集と revision を返し、画面が遅れて届いた応答を捨てられるようにする
pub fn save(
    lib: &mut Library,
    edit: Edit,
    revision: u64,
    snapshot: &Snapshot,
) -> Result<EditingBoard, String> {
    check_session(lib, edit.library_session)?;
    let Some((current, saved_revision)) = lib.board_session.editing else {
        return Err("このボードの編集は終了しています".into());
    };
    if current != edit || revision <= saved_revision || revision > i64::MAX as u64 {
        return Err("古いボードの保存要求のため、保存を中止しました".into());
    }
    validate(snapshot)?;
    let tx = lib.conn.transaction().map_err(err)?;
    let persisted = load_from(&tx, edit.board_id)?;
    if revision <= persisted.revision {
        return Err("古いボードの保存要求のため、保存を中止しました".into());
    }
    write_snapshot(&tx, edit.board_id, revision, snapshot)?;
    let board = load_from(&tx, edit.board_id)?;
    tx.commit().map_err(err)?;
    lib.board_session.editing = Some((edit, revision));
    Ok(EditingBoard { edit, board })
}

fn validate(snapshot: &Snapshot) -> Result<(), String> {
    let v = snapshot.viewport;
    if ![v.x, v.y, v.scale].iter().all(|n| n.is_finite()) || v.scale <= 0.0 {
        return Err("ボードの表示位置・倍率が不正です".into());
    }
    let mut ids = HashSet::new();
    for item in &snapshot.items {
        if item.id.is_some_and(|id| !ids.insert(id)) {
            return Err("同じ配置IDが複数あります".into());
        }
        let g = &item.geometry;
        if ![g.width, g.height, g.x, g.y, g.scale, g.rotation]
            .iter()
            .all(|n| n.is_finite())
            || g.width <= 0.0
            || g.height <= 0.0
            || g.scale <= 0.0
        {
            return Err("画像の配置・寸法・倍率が不正です".into());
        }
        if let Some(c) = g.crop {
            if ![c.x, c.y, c.width, c.height].iter().all(|n| n.is_finite())
                || c.x < 0.0
                || c.y < 0.0
                || c.width <= 0.0
                || c.height <= 0.0
                || c.x + c.width > 1.0
                || c.y + c.height > 1.0
            {
                return Err("トリミング範囲が元画像の範囲外です".into());
            }
        }
    }
    Ok(())
}

fn write_snapshot(
    tx: &Transaction,
    board: BoardId,
    revision: u64,
    snapshot: &Snapshot,
) -> Result<(), String> {
    tx.execute(
        "UPDATE board_items SET active = 0 WHERE board_id = ?1",
        [board.0],
    )
    .map_err(err)?;
    for item in &snapshot.items {
        let sql = match item.id {
            Some(id) => {
                let binding = tx
                    .query_row(
                        "SELECT board_id, source_id FROM board_items WHERE id = ?1",
                        [id.0],
                        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .optional()
                    .map_err(err)?;
                if binding != Some((board.0, item.source_id.0)) {
                    return Err("配置のボード・元画像は変更できません".into());
                }
                "UPDATE board_items SET width = ?4, height = ?5, x = ?6, y = ?7, scale = ?8,
                 rotation = ?9, flipped = ?10, grayscale = ?11, crop_x = ?12, crop_y = ?13,
                 crop_width = ?14, crop_height = ?15, stack_order = ?16, active = 1
                 WHERE id = ?1 AND board_id = ?2 AND source_id = ?3"
            }
            None => {
                available(&source(tx, item.source_id)?)?;
                "INSERT INTO board_items(id, board_id, source_id, width, height, x, y, scale,
                 rotation, flipped, grayscale, crop_x, crop_y, crop_width, crop_height, stack_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
            }
        };
        let g = &item.geometry;
        tx.execute(
            sql,
            params![
                item.id.map(|id| id.0),
                board.0,
                item.source_id.0,
                g.width,
                g.height,
                g.x,
                g.y,
                g.scale,
                g.rotation,
                g.flipped,
                g.grayscale,
                g.crop.map(|c| c.x),
                g.crop.map(|c| c.y),
                g.crop.map(|c| c.width),
                g.crop.map(|c| c.height),
                g.stack_order
            ],
        )
        .map_err(err)?;
    }
    tx.execute(
        "UPDATE boards SET viewport_x = ?1, viewport_y = ?2, viewport_scale = ?3,
         updated_at = ?4, revision = ?5 WHERE id = ?6",
        params![
            snapshot.viewport.x,
            snapshot.viewport.y,
            snapshot.viewport.scale,
            crate::import::millis(SystemTime::now())?,
            revision as i64,
            board.0
        ],
    )
    .map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests;
