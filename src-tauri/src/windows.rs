//! ウィンドウの開閉と終了の手順。閉じる前に画面の保存を待つこと、アイデアボードの専用ウィンドウの
//! 位置・最前面・不透明度、ギャラリーの状態に合わせたメニューの有効・無効を扱う

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use objc2_app_kit::NSWindow;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};

use crate::{backfill, menu, settings, settings_file, settle, Reveal, BOARD};

/// 画面が保存を終えるのを待つ上限。超えたら保存できなかったとして遷移を止める
const SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

/// labels のウィンドウに未保存の変更を保存させ、すべて終わるまで待つ（FR-704、FR-105、FR-411）。
/// 失敗した画面はその場でエラーを出すので、ここは遷移を止める理由だけを返す。
/// 返り値を drop すると画面へ release を送り、止めていた編集を戻させる
pub(crate) async fn settle(app: &AppHandle, labels: &[&str]) -> Result<Held, String> {
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

pub(crate) struct Held {
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
pub(crate) fn flush_ready(window: Window, settle: State<settle::Settle>) {
    settle.ready(window.label());
}

/// 画面が保存の依頼に答える。error が None なら保存できた
#[tauri::command]
pub(crate) fn flush_done(
    window: Window,
    settle: State<settle::Settle>,
    id: u64,
    error: Option<String>,
) {
    settle.reply(window.label(), id, error.map_or(Ok(()), Err));
}

/// 元URLの補完の終了か中断を待ってから、ボードの保存を待って閉じる。ライブラリ選択画面へ戻るときに
/// ギャラリーが呼ぶ（FR-105、FR-208）
#[tauri::command]
pub(crate) async fn close_board_window(app: AppHandle) -> Result<(), String> {
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
pub(crate) fn quit(app: &AppHandle) {
    quit_then(app, |app, ok| {
        if ok {
            app.exit(0);
        }
    });
}

/// ボードとメモの保存を待ち、終了してよいかを done に渡す。Dock からの終了（terminate.rs）とも共有する
pub(crate) fn quit_then(app: &AppHandle, done: impl FnOnce(&AppHandle, bool) + Send + 'static) {
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
pub(crate) fn close_board_after_save(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(_held) = settle(&app, &[BOARD]).await {
            close_board(&app);
        }
    });
}

pub(crate) fn close_board(app: &AppHandle) {
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
pub(crate) async fn show_board_window(app: AppHandle) -> Result<(), String> {
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
            .always_on_top(pinned(&app, display.always_on_top))
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
pub(crate) struct BoardFrame(Mutex<Option<settings::Rect>>);

pub(crate) fn track_board_frame(w: &Window) {
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

pub(crate) fn remember_board_frame(app: &AppHandle) {
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
pub(crate) fn set_board_display(
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
        .set_always_on_top(pinned(&app, always_on_top))
        .and_then(|_| set_alpha(&window, f64::from(opacity) / 100.0))
        .map_err(|e| format!("表示を変えられません（{e}）"))
}

/// ギャラリーの状態のうち、メニューとボードの最前面に効くもの（NFR-12、FR-705）
#[derive(Default, Clone, Copy)]
pub(crate) struct GalleryState {
    /// ギャラリーが手前のウィンドウか
    pub(crate) front: bool,
    /// 追加できる画像を選んでいるか
    addable: bool,
    /// ギャラリーでダイアログを開いているか
    dialog: bool,
}

/// ギャラリーの状態を変え、「ボードに追加…」の有効・無効に当てる。追加できるのは、ギャラリーが手前で
/// 追加できる画像を選び、ダイアログを開いていないときだけ（FR-701）
pub(crate) fn update_gallery(app: &AppHandle, change: impl FnOnce(&mut GalleryState)) {
    let g = {
        let state = app.state::<Mutex<GalleryState>>();
        let mut g = state.lock().unwrap_or_else(PoisonError::into_inner);
        change(&mut g);
        *g
    };
    if let Err(e) = menu::enable(app, menu::ADD_TO_BOARD, g.front && g.addable && !g.dialog) {
        log::warn!("「ボードに追加…」の有効・無効を変えられません：{e}");
    }
}

/// ボードを最前面に固定するか。ギャラリーでダイアログを開いている間は外す。固定したボードの後ろに
/// ギャラリーの設定や確認のダイアログが隠れ、押せなくなるため（FR-705）
fn pinned(app: &AppHandle, always_on_top: bool) -> bool {
    always_on_top
        && !app
            .state::<Mutex<GalleryState>>()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .dialog
}

/// ギャラリーが、追加できる画像を選んでいるかと、ダイアログを開いているかを知らせる。
/// ライブラリ選択画面へ戻るときは両方 false で知らせる
#[tauri::command]
pub(crate) fn report_gallery(app: AppHandle, addable: bool, dialog: bool) {
    update_gallery(&app, |g| {
        g.addable = addable;
        g.dialog = dialog;
    });
    let Some(w) = app.get_webview_window(BOARD) else {
        return;
    };
    let always_on_top = settings_file(&app)
        .map(|file| settings::load(&file).board_window.always_on_top)
        .unwrap_or_default();
    if let Err(e) = w.set_always_on_top(pinned(&app, always_on_top)) {
        log::warn!("アイデアボードの最前面の固定を変えられません：{e}");
    }
}
