//! メニューバー。構成は Tauri の初期のメニューと同じにし、文字だけを日本語にする
//! （Tauri の初期のメニューは文字が英語に固定されているため、作り直す）

use tauri::menu::{
    AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);

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
                    &PredefinedMenuItem::quit(app, Some(&format!("{name} を終了")))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "ファイル",
                true,
                &[&PredefinedMenuItem::close_window(
                    app,
                    Some("ウインドウを閉じる"),
                )?],
            )?,
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
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "ウインドウ",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, Some("しまう"))?,
                    &PredefinedMenuItem::maximize(app, Some("拡大／縮小"))?,
                    &sep()?,
                    &PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "ヘルプ", true, &[])?,
        ],
    )
}
