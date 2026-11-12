mod backfill;
pub mod board;
mod category;
mod fileops;
mod gallery;
mod import;
mod library;
mod menu;
mod recent;
mod settings;
mod settle;
mod source;
mod sync;
mod tag;
mod terminate;
mod trash;

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use library::{Access, Library};
use objc2_app_kit::NSWindow;
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

/// アイデアボードの専用ウィンドウのラベル。同時に開くのは1つだけ（FR-701）
const BOARD: &str = "board";

// 開いているライブラリ。後のタスクのコマンドはここから DB を使う
#[derive(Default)]
struct Current(Mutex<Option<Library>>);

fn app_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 開発版（tauri dev とデバッグビルド）はリリース版と ID が同じなので、データフォルダを分けないと
    // リリース版の「最近使ったライブラリ」から本物のライブラリを自動で開き、DB を新しい版に移行してしまう
    let dir = if cfg!(debug_assertions) {
        dir.join("debug")
    } else {
        dir
    };
    Ok(dir.join(name))
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_file(app, "settings.json")
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_file(app, "recent-libraries.json")
}

/// 画面が直接読めるのは開いたライブラリの画像とサムネイルだけにし、DB とゴミ箱は読めないようにする
fn allow_assets<R: Runtime>(app: &AppHandle<R>, root: &std::path::Path) -> tauri::Result<()> {
    let scope = app.asset_protocol_scope();
    let kura = root.join(library::KURA_DIR);
    // ルートの ** は . で始まる .kura に入らないので、サムネイルは別に許可する。
    // DB とゴミ箱はそれに頼らず明示的に禁じる（forbid は allow より優先される）
    scope.allow_directory(root, true)?;
    scope.allow_directory(library::thumbs_dir(root), true)?;
    for name in ["kura.db", "kura.db-wal", "kura.db-shm"] {
        scope.forbid_file(kura.join(name))?;
    }
    scope.forbid_directory(kura.join("trash"), true)
}

fn activate(
    app: &AppHandle,
    current: &Current,
    result: Result<Library, String>,
) -> Result<PathBuf, String> {
    let lib = result.inspect_err(|e| log::warn!("{e}"))?;
    let root = lib.root.clone();
    allow_assets(app, &root).map_err(|e| e.to_string())?;
    if let Err(e) = recent::push(&recent_file(app)?, &root) {
        // 一覧に残せなくてもライブラリは使えるので、開く処理は止めない
        log::error!("最近使ったライブラリを保存できません：{e}");
    }
    *current.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(lib);
    // ボードは開いたライブラリの中にあるので、前のライブラリのボードを出したままにしない
    close_board(app);
    log::info!("ライブラリを開きました：{}", root.display());
    Ok(root)
}

#[tauri::command]
fn list_recent_libraries(app: AppHandle) -> Vec<PathBuf> {
    // 起動時に画面が最初に呼ぶので、失敗を返すと画面が何も出せない。壊れた一覧のファイルと同じく空として扱う
    recent_file(&app)
        .inspect_err(|e| log::error!("最近使ったライブラリを読めません：{e}"))
        .map(|file| recent::load(&file))
        .unwrap_or_default()
}

/// 最近使ったライブラリのうち、フォルダが見つからないもの（FR-106）。外付けドライブの応答を待つことが
/// あるので、画面のスレッドを止めないよう async にする
#[tauri::command]
async fn missing_recent_libraries(app: AppHandle) -> Vec<PathBuf> {
    recent::missing(&list_recent_libraries(app))
}

/// 最近使ったライブラリの一覧から外す。ライブラリのフォルダと DB は変えない（FR-106）
#[tauri::command]
fn forget_recent_library(app: AppHandle, path: PathBuf) -> Result<Vec<PathBuf>, String> {
    recent::remove(&recent_file(&app)?, &path)
        .map_err(|e| format!("最近使ったライブラリの一覧を保存できません（{e}）"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> settings::Settings {
    // list_recent_libraries と同じく、失敗は壊れた設定のファイルと同じく初期値として扱う
    settings_file(&app)
        .inspect_err(|e| log::error!("設定を読めません：{e}"))
        .map(|file| settings::load(&file))
        .unwrap_or_default()
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    // OFF にする前にボードの保存を待つ。保存できなければ ON のままにし、ボードを開いたままにする（FR-711）
    let _held = if settings.board_enabled {
        None
    } else {
        Some(settle(&app, &[BOARD]).await?)
    };
    settings::save_and_apply(&settings_file(&app)?, &settings, |before, after| {
        if after.board_enabled == before.board_enabled {
            return Ok(());
        }
        // OFF ではボードの項目と ⌘B をメニューから外し、開いているボードを閉じる（FR-711）
        menu::build(&app, after.board_enabled)
            .and_then(|m| app.set_menu(m))
            .map_err(|e| format!("メニューを変えられません（{e}）"))?;
        if !after.board_enabled {
            close_board(&app);
        }
        Ok(())
    })
}

/// 画面が保存を終えるのを待つ上限。超えたら保存できなかったとして遷移を止める
const SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

/// labels のウィンドウに未保存の変更を保存させ、すべて終わるまで待つ（FR-704、FR-105、FR-411）。
/// 失敗した画面はその場でエラーを出すので、ここは遷移を止める理由だけを返す。
/// 返り値を drop すると画面へ release を送り、止めていた編集を戻させる
async fn settle(app: &AppHandle, labels: &[&str]) -> Result<Held, String> {
    let round = app.state::<settle::Settle>().begin(labels)?;
    log::info!(
        "保存を待ちます：{:?}",
        round.requests.iter().map(|(l, _)| l).collect::<Vec<_>>()
    );
    let held = Held {
        app: app.clone(),
        labels: round.requests.iter().map(|(l, _)| l.clone()).collect(),
    };
    for (label, id) in &round.requests {
        app.emit_to(label.as_str(), "flush", id)
            .map_err(|e| format!("保存を頼めません（{e}）"))?;
    }
    tauri::async_runtime::spawn_blocking(move || round.wait(SETTLE_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
        .inspect_err(|e| log::warn!("保存を待てなかったので操作を中止しました：{e}"))?;
    Ok(held)
}

struct Held {
    app: AppHandle,
    labels: Vec<String>,
}

impl Drop for Held {
    fn drop(&mut self) {
        for label in &self.labels {
            // 閉じたウィンドウには届かなくてよい
            let _ = self.app.emit_to(label.as_str(), "release", ());
        }
    }
}

/// 画面が保存の依頼を受け取れるようになった
#[tauri::command]
fn flush_ready(window: Window, settle: State<settle::Settle>) {
    settle.ready(window.label());
}

/// 画面が保存の依頼に答える。error が None なら保存できた
#[tauri::command]
fn flush_done(window: Window, settle: State<settle::Settle>, id: u64, error: Option<String>) {
    settle.reply(window.label(), id, error.map_or(Ok(()), Err));
}

/// 元URLの補完の終了か中断を待ってから、ボードの保存を待って閉じる。ライブラリ選択画面へ戻るときに
/// ギャラリーが呼ぶ（FR-105、FR-208）
#[tauri::command]
async fn close_board_window(app: AppHandle) -> Result<(), String> {
    let gate = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        drop(gate.state::<backfill::Gate>().inner().wait())
    })
    .await
    .map_err(|e| e.to_string())?;
    let _held = settle(&app, &[BOARD]).await?;
    close_board(&app);
    Ok(())
}

/// ボードとメモの保存を待ってから終了する。失敗したら終了しない（FR-704、FR-411）
fn quit(app: &AppHandle) {
    quit_then(app, |app, ok| {
        if ok {
            app.exit(0);
        }
    });
}

/// ボードとメモの保存を待ち、終了してよいかを done に渡す。Dock からの終了（terminate.rs）とも共有する
fn quit_then(app: &AppHandle, done: impl FnOnce(&AppHandle, bool) + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ok = settle(&app, &[BOARD, "main"]).await.is_ok();
        if ok {
            // 終了ではボードのウィンドウの Destroyed が届くとは限らないので、ここでも枠を保存する
            remember_board_frame(&app);
            log::info!("保存を終えたので終了します");
        }
        done(&app, ok);
    });
}

/// ボードの保存を待ってから閉じる。ギャラリーは残す（FR-704）
fn close_board_after_save(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(_held) = settle(&app, &[BOARD]).await {
            close_board(&app);
        }
    });
}

fn close_board(app: &AppHandle) {
    // 前のライブラリのボード ID を、次のライブラリのボードとして開かせない
    app.state::<Reveal>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(w) = app.get_webview_window(BOARD) {
        if let Err(e) = w.destroy() {
            log::warn!("アイデアボードを閉じられません：{e}");
        }
    }
}

/// アイデアボードの専用ウィンドウを開く。開いていれば手前に出す（FR-701）。
/// 同期のコマンドでウィンドウを作ると止まる環境があるので async にする
#[tauri::command]
async fn show_board_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(BOARD) {
        return w
            .unminimize()
            .and_then(|_| w.show())
            .and_then(|_| w.set_focus())
            .map_err(|e| e.to_string());
    }
    // ウィンドウは閉じるたびに破棄するので、開くたびに設定から最前面・不透明度・枠を当てる（FR-705、FR-707）
    let display = settings_file(&app)
        .map(|file| settings::load(&file).board_window)
        .unwrap_or_default();
    let open = || {
        // 枠と不透明度を当て終えてから見せる。先に見せると、前の位置に不透明なまま一瞬出る
        let w = WebviewWindowBuilder::new(&app, BOARD, WebviewUrl::App("index.html".into()))
            .title("アイデアボード")
            // 上部の操作が1段に収まる幅
            .inner_size(1040.0, 640.0)
            .min_inner_size(480.0, 320.0)
            .always_on_top(display.always_on_top)
            .visible(false)
            .build()?;
        if let Err(e) = place_board(&app, &w, display.frame) {
            log::warn!("アイデアボードの位置と大きさを戻せません：{e}");
        }
        set_alpha(&w, display.alpha())?;
        w.show()?;
        w.set_focus()
    };
    open().map_err(|e| format!("アイデアボードを開けません（{e}）"))
}

/// 今つながっている画面の、Dock とメニューバーを除いた範囲。メイン画面のあるディスプレイを先頭にする
fn screens(app: &AppHandle) -> tauri::Result<Vec<settings::Rect>> {
    let rect = |m: &tauri::Monitor| {
        let scale = m.scale_factor();
        let area = m.work_area();
        let position = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        settings::Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }
    };
    let mut all: Vec<_> = app.available_monitors()?.iter().map(rect).collect();
    let home = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .and_then(|m| all.iter().position(|r| *r == rect(&m)));
    if let Some(home) = home {
        all.swap(0, home);
    }
    Ok(all)
}

/// タイトルバーを含むウィンドウの枠。settings::Rect と同じ単位にする
fn frame_of(w: &Window) -> tauri::Result<settings::Rect> {
    let scale = w.scale_factor()?;
    let position = w.outer_position()?.to_logical::<f64>(scale);
    let size = w.outer_size()?.to_logical::<f64>(scale);
    Ok(settings::Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// 保存した枠を今の画面の中に収めてから当てる。初回はメイン画面のあるディスプレイの中央（FR-705）
fn place_board(
    app: &AppHandle,
    w: &WebviewWindow,
    saved: Option<settings::Rect>,
) -> tauri::Result<()> {
    let outer = frame_of(&w.as_ref().window())?;
    let Some(placed) = settings::place(saved, (outer.width, outer.height), &screens(app)?) else {
        return Ok(());
    };
    // set_size は中身の大きさを取るので、タイトルバーの分を引く
    let inner = w.inner_size()?.to_logical::<f64>(w.scale_factor()?);
    w.set_size(LogicalSize::new(
        placed.width - (outer.width - inner.width),
        placed.height - (outer.height - inner.height),
    ))?;
    w.set_position(LogicalPosition::new(placed.x, placed.y))
}

/// ウィンドウ全体（タイトルバーを含む）の不透明度を変える（FR-707）。Tauri には全体に効く設定がないので
/// NSWindow に直接渡す（spikes/board-native で確かめた方法）。クリックを背後へ通す設定には触れない
fn set_alpha(w: &WebviewWindow, alpha: f64) -> tauri::Result<()> {
    let window = w.clone();
    w.run_on_main_thread(move || match window.ns_window() {
        // SAFETY: NSWindow は Tauri が持つ。メインスレッドのこの場だけで使い、ポインターを外へ持ち出さない
        Ok(ns) => unsafe { &*ns.cast::<NSWindow>() }.setAlphaValue(alpha),
        Err(e) => log::warn!("アイデアボードの不透明度を変えられません：{e}"),
    })
}

/// 動かしたり大きさを変えたりした後の、ボードのウィンドウの枠。設定のファイルには、動かすたびではなく
/// 閉じるときと終了のときに書く
#[derive(Default)]
struct BoardFrame(Mutex<Option<settings::Rect>>);

fn track_board_frame(w: &Window) {
    // 開く途中（見せる前）の枠と、最小化・フルスクリーンの間の枠は、次に開く枠にしない
    let usual = w.is_visible().unwrap_or(false)
        && !w.is_minimized().unwrap_or(true)
        && !w.is_fullscreen().unwrap_or(true);
    if !usual {
        return;
    }
    if let Ok(frame) = frame_of(w) {
        *w.state::<BoardFrame>()
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(frame);
    }
}

fn remember_board_frame(app: &AppHandle) {
    let frame = *app
        .state::<BoardFrame>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let Some(frame) = frame else { return };
    let saved = settings_file(app).and_then(|file| {
        settings::update(&file, |s| s.board_window.frame = Some(frame)).map_err(|e| e.to_string())
    });
    // 保存できなくても閉じる。失うのは次に開く位置だけで、ボードの中身ではない
    if let Err(e) = saved {
        log::warn!("アイデアボードの位置と大きさを保存できません：{e}");
    }
}

/// 最前面に固定するかと不透明度を変える（FR-705、FR-707）。設定に保存できてからウィンドウに当てる。
/// 保存できなければ当てずにエラーを返し、画面は前の値に戻る
#[tauri::command]
fn set_board_display(
    app: AppHandle,
    window: WebviewWindow,
    always_on_top: bool,
    opacity: u8,
) -> Result<(), String> {
    if window.label() != BOARD {
        return Err("アイデアボードのウィンドウからだけ変えられます".into());
    }
    if !settings::OPACITY.contains(&opacity) {
        return Err("不透明度は30〜100%の範囲で指定してください".into());
    }
    settings::update(&settings_file(&app)?, |s| {
        s.board_window.always_on_top = always_on_top;
        s.board_window.opacity = opacity;
    })
    .map_err(|e| format!("表示の設定を保存できません（{e}）"))?;
    window
        .set_always_on_top(always_on_top)
        .and_then(|_| set_alpha(&window, f64::from(opacity) / 100.0))
        .map_err(|e| format!("表示を変えられません（{e}）"))
}

/// ボードの一覧と、以後のボードの操作に添えるライブラリのトークン
#[derive(Serialize)]
struct Boards {
    session: board::LibrarySession,
    #[serde(flatten)]
    list: board::List,
}

#[tauri::command]
fn list_boards(current: State<Current>) -> Result<Boards, String> {
    current.0.with(|lib| {
        let session = board::session(lib);
        let list = board::list(lib, session)?;
        Ok(Boards { session, list })
    })
}

#[tauri::command]
fn open_board(
    current: State<Current>,
    session: board::LibrarySession,
    id: board::BoardId,
) -> Result<board::EditingBoard, String> {
    current.0.with(|lib| board::open(lib, session, id))
}

/// 空のボードを作る。作ったボードを最後に使ったボードにする
#[tauri::command]
fn create_board(
    current: State<Current>,
    session: board::LibrarySession,
    name: String,
) -> Result<board::EditingBoard, String> {
    let empty = board::Snapshot {
        viewport: board::Viewport::default(),
        items: vec![],
    };
    current
        .0
        .with(|lib| board::create(lib, session, &name, &empty))
}

#[tauri::command]
fn rename_board(
    current: State<Current>,
    session: board::LibrarySession,
    id: board::BoardId,
    name: String,
) -> Result<board::Summary, String> {
    current.0.with(|lib| board::rename(lib, session, id, &name))
}

/// 配置を動かしたボードを保存する（FR-702、FR-704）。edit と revision の検査は board::save が行う
#[tauri::command]
fn save_board(
    current: State<Current>,
    edit: board::Edit,
    revision: u64,
    snapshot: board::Snapshot,
) -> Result<board::EditingBoard, String> {
    current
        .0
        .with(|lib| board::save(lib, edit, revision, &snapshot))
}

/// ギャラリーから追加した結果。ボードのウィンドウが開いて読み取り、追加分を選んで表示する（FR-701）。
/// ウィンドウを新しく作るときはイベントが画面の準備より先に届くので、ここに残して取りに来させる
#[derive(Default)]
struct Reveal(Mutex<Option<board::Added>>);

/// 選んだ画像をボードに追加し、そのボードを専用ウィンドウで開いて手前に出す（FR-701）
#[tauri::command]
async fn add_to_board(
    app: AppHandle,
    session: board::LibrarySession,
    target: board::Target,
    images: Vec<i64>,
) -> Result<(), String> {
    // 追加はボードの編集を終わらせるので、先に開いているボードの保存を待つ。待たないと、追加の後に届いた
    // 保存が断られて動かした位置が消える。開き直すまでボードは編集を止めている
    let _held = settle(&app, &[BOARD])
        .await
        .map_err(|e| format!("ボードを保存できないため、追加できません（{e}）"))?;
    let added = app
        .state::<Current>()
        .0
        .with(|lib| board::add(lib, session, &target, &images))?;
    log::info!(
        "ボードに追加しました：ボード {}、{}枚",
        added.board_id.0,
        added.placements.len()
    );
    *app.state::<Reveal>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(added);
    show_board_window(app.clone()).await?;
    if let Err(e) = app.emit_to(BOARD, "board-reveal", ()) {
        log::warn!("ボードに追加を知らせられません：{e}");
    }
    Ok(())
}

#[tauri::command]
fn board_sources(
    current: State<Current>,
    session: board::LibrarySession,
    ids: Vec<board::SourceId>,
) -> Result<Vec<board::Source>, String> {
    current.0.with(|lib| board::refresh(lib, session, &ids))
}

/// 元画像の状態か場所が変わったかもしれないことを、開いているボードに知らせる（FR-104、FR-511）。
/// ボードが board_sources で引き直す。閉じていれば届かなくてよい
fn notify_board(app: &AppHandle) {
    if let Err(e) = app.emit_to(BOARD, "images-changed", ()) {
        log::warn!("ボードに画像の変更を知らせられません：{e}");
    }
}

/// ボードの「ギャラリーで表示」。メインウィンドウを手前に出し、画像を選ぶのはギャラリーの画面に任せる（FR-701）。
/// ボードのウィンドウは開いたままにする
#[tauri::command]
fn show_in_gallery(app: AppHandle, id: i64) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or("ギャラリーのウィンドウがありません")?;
    w.unminimize()
        .and_then(|_| w.show())
        .and_then(|_| w.set_focus())
        .and_then(|_| app.emit_to("main", "gallery-reveal", id))
        .map_err(|e| format!("ギャラリーで表示できません（{e}）"))
}

#[tauri::command]
fn take_board_reveal(reveal: State<Reveal>) -> Option<board::Added> {
    reveal
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/// ボードと配置だけを消す。元画像はライブラリに残す（FR-701）
#[tauri::command]
fn delete_board(
    current: State<Current>,
    session: board::LibrarySession,
    id: board::BoardId,
) -> Result<(), String> {
    current.0.with(|lib| board::delete(lib, session, id))
}

#[tauri::command]
fn location_warning(path: PathBuf) -> Option<String> {
    library::location_warning(&path)
}

#[tauri::command]
fn create_library(
    app: AppHandle,
    current: State<Current>,
    path: PathBuf,
) -> Result<PathBuf, String> {
    activate(&app, &current, library::create(&path))
}

#[tauri::command]
fn open_library(app: AppHandle, current: State<Current>, path: PathBuf) -> Result<PathBuf, String> {
    activate(&app, &current, library::open(&path))
}

#[tauri::command]
fn load_gallery(current: State<Current>) -> Result<gallery::Gallery, String> {
    current.0.with(|lib| gallery::load(lib))
}

#[tauri::command]
fn image_detail(current: State<Current>, id: i64) -> Result<gallery::Detail, String> {
    current.0.with(|lib| gallery::detail(lib, id))
}

/// Finder で画像を選んだ状態で開く。id がなければライブラリのフォルダを開く。
/// 画面からはパスを受け取らず DB から組み立てる。開いたライブラリの外を開かせないため
#[tauri::command]
fn show_in_finder(current: State<Current>, id: Option<i64>) -> Result<(), String> {
    let args = current.0.with(|lib| match id {
        Some(id) => Ok(vec!["-R".into(), gallery::detail(lib, id)?.path]),
        None => Ok(vec![lib.root.clone()]),
    })?;
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder で開けません（{status}）"))
    }
}

/// 画像の元URLを既定のブラウザで開く（FR-208）。画面からは URL を受け取らず、DB の値を確かめ直して渡す。
/// HTTP と HTTPS 以外を開かせないため
#[tauri::command]
fn open_source_url(current: State<Current>, id: i64) -> Result<(), String> {
    let url = current.0.with(|lib| {
        gallery::detail(lib, id)?
            .source
            .and_then(|s| s.link)
            .ok_or("開けるURLがありません".into())
    })?;
    source::open("open", &url)
}

#[tauri::command]
fn set_memo(current: State<Current>, id: i64, memo: String) -> Result<(), String> {
    current.0.with(|lib| gallery::set_memo(lib, id, &memo))
}

#[tauri::command]
fn set_rating(current: State<Current>, id: i64, rating: i64) -> Result<(), String> {
    current.0.with(|lib| gallery::set_rating(lib, id, rating))
}

/// 画像を移すので、取り込みと同じく別のスレッドで行う（同期のコマンドは画面のスレッドを止める）
#[tauri::command]
async fn set_category(
    app: AppHandle,
    ids: Vec<i64>,
    category: Option<i64>,
) -> Result<category::Assigned, String> {
    with_library(app, move |lib| {
        let result = category::assign(lib, &ids, category)?;
        for f in &result.failed {
            log::warn!("画像 {} のカテゴリを変えられません：{}", f.id, f.message);
        }
        Ok(result)
    })
    .await
}

/// parent の下（None はルート直下）にカテゴリとフォルダを作る（FR-401）。返り値は新しいカテゴリの id
#[tauri::command]
async fn create_category(app: AppHandle, parent: Option<i64>, name: String) -> Result<i64, String> {
    with_library(app, move |lib| category::create(lib, parent, &name)).await
}

/// 画像のファイル名を変える（FR-410）。stem は拡張子より前の部分。返り値は変えた後のファイル名
#[tauri::command]
async fn rename_image(app: AppHandle, id: i64, stem: String) -> Result<String, String> {
    with_library(app, move |lib| category::rename_image(lib, id, &stem)).await
}

/// フォルダの名前を変えたり移したりするので、set_category と同じく別のスレッドで行う
#[tauri::command]
async fn rename_category(app: AppHandle, id: i64, name: String) -> Result<(), String> {
    with_library(app, move |lib| category::rename(lib, id, &name)).await
}

#[tauri::command]
async fn move_category(app: AppHandle, id: i64, parent: Option<i64>) -> Result<(), String> {
    with_library(app, move |lib| category::move_to(lib, id, parent)).await
}

#[tauri::command]
async fn delete_category(app: AppHandle, id: i64) -> Result<category::Deleted, String> {
    with_library(app, move |lib| category::delete(lib, id)).await
}

#[tauri::command]
fn set_categories_collapsed(
    current: State<Current>,
    ids: Vec<i64>,
    collapsed: bool,
) -> Result<(), String> {
    current
        .0
        .with(|lib| category::set_collapsed(lib, &ids, collapsed))
}

#[tauri::command]
fn image_tags(current: State<Current>, ids: Vec<i64>) -> Result<Vec<tag::Counted>, String> {
    current.0.with(|lib| tag::of(lib, &ids))
}

#[tauri::command]
fn add_tag(current: State<Current>, ids: Vec<i64>, name: String) -> Result<gallery::Tag, String> {
    current.0.with(|lib| tag::add(lib, &ids, &name))
}

#[tauri::command]
fn remove_tag(current: State<Current>, ids: Vec<i64>, tag_id: i64) -> Result<(), String> {
    current.0.with(|lib| tag::remove(lib, &ids, tag_id))
}

#[tauri::command]
fn rename_tag(current: State<Current>, id: i64, name: String) -> Result<gallery::Tag, String> {
    current.0.with(|lib| tag::rename(lib, id, &name))
}

#[tauri::command]
fn merge_tag(current: State<Current>, from: i64, into: i64) -> Result<(), String> {
    current.0.with(|lib| tag::merge(lib, from, into))
}

#[tauri::command]
fn delete_tag(current: State<Current>, id: i64) -> Result<(), String> {
    current.0.with(|lib| tag::delete(lib, id))
}

#[tauri::command]
fn load_trash(current: State<Current>) -> Result<Vec<gallery::Image>, String> {
    current.0.with(|lib| gallery::trash(lib))
}

/// 画像をゴミ箱へ移す・戻す・ゴミ箱を空にする（FR-511）。ファイルを動かすので別のスレッドで行う
#[tauri::command]
async fn trash_images(app: AppHandle, ids: Vec<i64>) -> Result<trash::Done, String> {
    with_library(app, move |lib| trash::trash(lib, &ids)).await
}

#[tauri::command]
async fn restore_images(app: AppHandle, ids: Vec<i64>) -> Result<trash::Restored, String> {
    with_library(app, move |lib| trash::restore(lib, &ids)).await
}

#[tauri::command]
async fn purge_images(app: AppHandle, ids: Vec<i64>) -> Result<trash::Done, String> {
    with_library(app, move |lib| trash::purge(lib, &ids)).await
}

#[tauri::command]
async fn empty_trash(app: AppHandle) -> Result<trash::Done, String> {
    with_library(app, trash::empty).await
}

#[tauri::command]
fn load_missing(current: State<Current>) -> Result<Vec<gallery::Image>, String> {
    current.0.with(|lib| gallery::missing(lib))
}

/// 差分検出（FR-104）。画面がライブラリを開いた後と、利用者がボタンを押したときに呼ぶ。
/// 進み具合を scan-progress イベントで知らせる。1枚ごとにロックを外すので、その間も他のコマンドを使える
#[tauri::command]
async fn scan_library(app: AppHandle) -> Result<sync::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _wait = app.state::<backfill::Gate>().inner().wait();
        let current = app.state::<Current>();
        let r = sync::scan(&current.0, |done, total| {
            if let Err(e) = app.emit("scan-progress", ImportProgress { done, total }) {
                log::warn!("差分検出の進み具合を送れません：{e}");
            }
        })?;
        log::info!(
            "差分を反映しました：登録 {}、移動 {}、更新 {}、見つからない {}、スキップ {}件",
            r.added,
            r.moved,
            r.updated,
            r.missing,
            r.skipped.len()
        );
        notify_board(&app);
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// DB を利用者が選んだファイルに書き出す（NFR-07）
#[tauri::command]
async fn backup_library(app: AppHandle, path: PathBuf) -> Result<(), String> {
    with_library(app, move |lib| {
        library::backup(lib, &path)?;
        log::info!("DB を書き出しました：{}", path.display());
        Ok(())
    })
    .await
}

/// 見つからない画像を DB から外す（FR-104）
#[tauri::command]
async fn forget_images(app: AppHandle, ids: Vec<i64>) -> Result<trash::Done, String> {
    with_library(app, move |lib| sync::forget(lib, &ids)).await
}

/// 開いているライブラリの元URLを、ライブラリ内のファイルのダウンロード元の記録から補完する（FR-208）。
/// 進み具合を backfill-progress イベントでギャラリーに知らせる。1枚ごとにロックを外すので、その間も
/// 閲覧・検索・ボードの編集はできる
#[tauri::command]
async fn backfill_sources(app: AppHandle) -> Result<backfill::Counts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = app
            .state::<backfill::Gate>()
            .run(&app.state::<Current>().0, |c| {
                if let Err(e) = app.emit_to("main", "backfill-progress", c) {
                    log::warn!("元URLの補完の進み具合を送れません：{e}");
                }
            })?;
        log::info!("元URLを補完しました：{c:?}");
        Ok(c)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 元URLの補完を、今の画像を調べ終えたところで止める。保存済みの元URLは残る（FR-208）
#[tauri::command]
fn cancel_backfill(gate: State<backfill::Gate>) {
    gate.cancel();
}

async fn with_library<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Library) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // 元URLの補完の途中なら、終わるか中断するまで待つ（FR-208）
        let _wait = app.state::<backfill::Gate>().inner().wait();
        app.state::<Current>().0.with(f)
    })
    .await
    .map_err(|e| e.to_string())?;
    // ファイルを動かす操作はここを通る。一部だけ成功した失敗もあるので、結果によらず知らせる
    notify_board(&handle);
    result
}

#[derive(Clone, Serialize)]
struct ImportProgress {
    done: usize,
    total: usize,
}

/// 別のスレッドで取り込み、進み具合を import-progress イベントで知らせる（FR-201）
#[tauri::command]
async fn import_paths(
    app: AppHandle,
    paths: Vec<PathBuf>,
    category: Option<i64>,
) -> Result<import::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _wait = app.state::<backfill::Gate>().inner().wait();
        let current = app.state::<Current>();
        let report = import::import_paths(&current.0, &paths, category, |done, total| {
            if let Err(e) = app.emit("import-progress", ImportProgress { done, total }) {
                log::warn!("取り込みの進み具合を送れません：{e}");
            }
        })?;
        log::info!(
            "取り込みました：{}枚、スキップ {}件",
            report.added,
            report.skipped.len()
        );
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            terminate::install(app.handle());
            Ok(())
        })
        .menu(|app| {
            let enabled = settings_file(app)
                .map(|file| settings::load(&file).board_enabled)
                .unwrap_or(true);
            menu::build(app, enabled)
        })
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT {
                quit(app);
                return;
            }
            // 開いているライブラリ（Current）は次のライブラリを開くまで残す。戻るかどうかは画面が決める。
            // ボードもギャラリーの画面が開く。ライブラリ選択画面ではボードを開かないため
            for id in [menu::SWITCH_LIBRARY, menu::OPEN_BOARD, menu::ADD_TO_BOARD] {
                if event.id() == id {
                    if let Err(e) = app.emit_to("main", id, ()) {
                        log::warn!("メニューの操作を画面に送れません（{id}）：{e}");
                    }
                }
            }
        })
        .on_window_event(|window, event| match event {
            // 閉じる前に保存を待つ。ギャラリーを閉じたらボードも保存して終了し、ボードだけならギャラリーを残す
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == BOARD {
                    close_board_after_save(window.app_handle());
                } else {
                    quit(window.app_handle());
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) if window.label() == BOARD => {
                track_board_frame(window);
            }
            WindowEvent::Destroyed => {
                if window.label() == BOARD {
                    remember_board_frame(window.app_handle());
                }
                window.state::<settle::Settle>().gone(window.label());
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .manage(Current::default())
        .manage(Reveal::default())
        .manage(settle::Settle::default())
        .manage(BoardFrame::default())
        .manage(backfill::Gate::default())
        .invoke_handler(tauri::generate_handler![
            list_recent_libraries,
            missing_recent_libraries,
            forget_recent_library,
            load_settings,
            save_settings,
            location_warning,
            create_library,
            open_library,
            import_paths,
            load_gallery,
            image_detail,
            show_in_finder,
            open_source_url,
            set_memo,
            set_rating,
            set_category,
            rename_image,
            create_category,
            rename_category,
            move_category,
            delete_category,
            set_categories_collapsed,
            image_tags,
            add_tag,
            remove_tag,
            rename_tag,
            merge_tag,
            delete_tag,
            load_trash,
            trash_images,
            restore_images,
            purge_images,
            empty_trash,
            load_missing,
            scan_library,
            forget_images,
            backup_library,
            backfill_sources,
            cancel_backfill,
            show_board_window,
            set_board_display,
            list_boards,
            open_board,
            create_board,
            rename_board,
            delete_board,
            save_board,
            add_to_board,
            take_board_reveal,
            board_sources,
            show_in_gallery,
            flush_ready,
            flush_done,
            close_board_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 画面からはライブラリの画像とサムネイルを読めてdbとゴミ箱とライブラリの外は読めない() {
        let app = tauri::test::mock_app();
        let root = std::path::Path::new("/Volumes/外付け/参考 [資料]");
        allow_assets(app.handle(), root).unwrap();
        let scope = app.asset_protocol_scope();

        for ok in ["ポーズ/座り/a.jpg", "_未分類/b.png", ".kura/thumbs/abc.jpg"] {
            assert!(scope.is_allowed(root.join(ok)), "{ok}");
        }
        for ng in [
            ".kura/kura.db",
            ".kura/kura.db-wal",
            ".kura/kura.db-shm",
            ".kura/trash/1.jpg",
        ] {
            assert!(!scope.is_allowed(root.join(ng)), "{ng}");
        }
        assert!(!scope.is_allowed("/Volumes/外付け/a.jpg"));
    }
}
