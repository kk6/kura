//! メニューバー。構成は Tauri の初期のメニューと同じにし、文字だけを日本語にする。
//! 終了は保存を待つ項目に置き換えた。
//! 足したのは「ファイル」の「ライブラリを切り替える…」「ボードに追加…」「似た画像を探す」
//! 「元が同じ画像の組を探す…」と「ウインドウ」の「アイデアボードを開く」だけ。
//! 「編集」の取り消す・やり直す・すべてを選択は、ボードとギャラリーに届くよう自前の項目に置き換えた
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

/// 選んだ1枚の「似た画像を探す」（FR-601、6章）。選ぶと main.rs がギャラリーへ find-similar イベントを送る
pub const FIND_SIMILAR: &str = "find-similar";

/// 元が同じ画像の組を探す項目（FR-611）。選ぶと main.rs がギャラリーへ find-origin-groups イベントを送る
pub const FIND_ORIGIN_GROUPS: &str = "find-origin-groups";

/// 「編集」の取り消す・やり直す・すべてを選択（FR-702、NFR-12）。選ぶと main.rs が手前のウィンドウへ
/// edit-menu イベントで id を送る。標準の項目は入力欄の文字にしか効かず、ボードの配置やギャラリーの画像に
/// 届かないので置き換えた。入力欄の文字の編集は画面が受け持つ（src/editMenu.ts）
pub const UNDO: &str = "undo";
pub const REDO: &str = "redo";
pub const SELECT_ALL: &str = "select-all";
pub const EDITS: [&str; 3] = [UNDO, REDO, SELECT_ALL];

/// 終了の項目。既定の終了は AppKit の terminate: を直接呼び、保存待ちを通らないので置き換える
/// （spikes/board-native）。選ぶと main.rs がボードとメモの保存を待ってから終了する（FR-704、FR-411）
pub const QUIT: &str = "quit";

/// board が false（アイデアボードが OFF。FR-711）なら、ボードの項目とショートカットを入れない。
/// similarity が false（類似画像検索が OFF）なら、類似画像検索の項目と ⇧⌘F を入れない（6章）
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    board: bool,
    similarity: bool,
) -> tauri::Result<Menu<R>> {
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
    // ギャラリーが手前で、追加できる画像を選んでいる間だけ、enable で有効にする
    let add_to_board = MenuItem::with_id(
        app,
        ADD_TO_BOARD,
        "ボードに追加…",
        false,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    // 「ボードに追加…」と同じく、詳細パネルのボタンを押せる間だけ enable で有効にする
    let find_similar = MenuItem::with_id(
        app,
        FIND_SIMILAR,
        "似た画像を探す",
        false,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let find_groups = MenuItem::with_id(
        app,
        FIND_ORIGIN_GROUPS,
        "元が同じ画像の組を探す…",
        true,
        None::<&str>,
    )?;
    let undo = MenuItem::with_id(app, UNDO, "取り消す", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, REDO, "やり直す", true, Some("CmdOrCtrl+Shift+Z"))?;
    let select_all = MenuItem::with_id(app, SELECT_ALL, "すべてを選択", true, Some("CmdOrCtrl+A"))?;
    let file_close = PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?;
    let file_seps = [sep()?, sep()?];
    let mut file: Vec<&dyn IsMenuItem<R>> = vec![&switch, &file_seps[0]];
    if board {
        file.push(&add_to_board);
    }
    if similarity {
        file.extend([&find_similar as &dyn IsMenuItem<R>, &find_groups]);
    }
    if board || similarity {
        file.push(&file_seps[1]);
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
                    &undo,
                    &redo,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, Some("カット"))?,
                    &PredefinedMenuItem::copy(app, Some("コピー"))?,
                    &PredefinedMenuItem::paste(app, Some("ペースト"))?,
                    &select_all,
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

/// 項目 id を有効・無効にする。メニューにない（OFF で外した）ときは何もしない
pub fn enable<R: Runtime>(app: &AppHandle<R>, id: &str, enabled: bool) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for submenu in menu.items()? {
        let item = submenu.as_submenu().and_then(|s| s.get(id));
        if let Some(item) = item.as_ref().and_then(|i| i.as_menuitem()) {
            item.set_enabled(enabled)?;
        }
    }
    Ok(())
}
