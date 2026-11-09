//! メニューバー。構成は Tauri の初期のメニューと同じにし、文字だけを日本語にする。
//! 終了は保存を待つ項目に置き換えた。
//! 足したのは「ファイル」の「ライブラリを切り替える…」「ボードに追加…」と「ウインドウ」の「アイデアボードを開く」だけ
//! （Tauri の初期のメニューは文字が英語に固定されているため、作り直す）

use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

/// ライブラリ選択画面へ戻る項目（FR-105）。選ぶと main.rs が画面へ switch-library イベントを送る
pub const SWITCH_LIBRARY: &str = "switch-library";

/// アイデアボードの専用ウィンドウを開く項目（FR-701）。選ぶと main.rs が画面へ open-board イベントを送る
pub const OPEN_BOARD: &str = "open-board";

/// 選んだ画像をボードに追加する項目（FR-701）。選ぶと main.rs がギャラリーへ add-to-board イベントを送る
pub const ADD_TO_BOARD: &str = "add-to-board";

/// 終了の項目。既定の終了は AppKit の terminate: を直接呼び、保存待ちを通らないので置き換える
/// （spikes/board-native）。選ぶと main.rs がボードとメモの保存を待ってから終了する（FR-704、FR-411）
pub const QUIT: &str = "quit";

/// board が false（アイデアボードが OFF。FR-711）なら、ボードの項目とショートカットを入れない
pub fn build<R: Runtime>(app: &AppHandle<R>, board: bool) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);
    let quit = MenuItem::with_id(
        app,
        QUIT,
        format!("{name} を終了"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let switch = MenuItem::with_id(
        app,
        SWITCH_LIBRARY,
        "ライブラリを切り替える…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let open_board = MenuItem::with_id(
        app,
        OPEN_BOARD,
        "アイデアボードを開く",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let add_to_board = MenuItem::with_id(
        app,
        ADD_TO_BOARD,
        "ボードに追加…",
        true,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let file_close = PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?;
    let file_seps = [sep()?, sep()?];
    let mut file: Vec<&dyn IsMenuItem<R>> = vec![&switch, &file_seps[0]];
    if board {
        file.extend([&add_to_board as &dyn IsMenuItem<R>, &file_seps[1]]);
    }
    file.push(&file_close);
    let minimize = PredefinedMenuItem::minimize(app, Some("しまう"))?;
    let maximize = PredefinedMenuItem::maximize(app, Some("拡大／縮小"))?;
    let separators = [sep()?, sep()?];
    let close = PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?;
    let mut window: Vec<&dyn IsMenuItem<R>> = vec![&minimize, &maximize, &separators[0]];
    if board {
        window.extend([&open_board as &dyn IsMenuItem<R>, &separators[1]]);
    }
    window.push(&close);

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &name,
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some(&format!("{name} について")),
                        Some(about),
                    )?,
                    &sep()?,
                    &PredefinedMenuItem::services(app, Some("サービス"))?,
                    &sep()?,
                    &PredefinedMenuItem::hide(app, Some(&format!("{name} を隠す")))?,
                    &PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?,
                    &sep()?,
                    &quit,
                ],
            )?,
            &Submenu::with_items(app, "ファイル", true, &file)?,
            &Submenu::with_items(
                app,
                "編集",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("取り消す"))?,
                    &PredefinedMenuItem::redo(app, Some("やり直す"))?,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, Some("カット"))?,
                    &PredefinedMenuItem::copy(app, Some("コピー"))?,
                    &PredefinedMenuItem::paste(app, Some("ペースト"))?,
                    &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "表示",
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some("フルスクリーンにする"),
                )?],
            )?,
            // この id のメニューを macOS がウインドウのメニューとみなし、整列などの項目を足す
            &Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, "ウインドウ", true, &window)?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "ヘルプ", true, &[])?,
        ],
    )
}
