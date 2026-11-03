mod library;
mod recent;

use std::path::PathBuf;
use std::sync::Mutex;

use library::Library;
use tauri::{AppHandle, Manager, State};

// 開いているライブラリ。後のタスクのコマンドはここから DB を使う
#[derive(Default)]
struct Current(Mutex<Option<Library>>);

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recent-libraries.json"))
}

fn activate(
    app: &AppHandle,
    current: &Current,
    result: Result<Library, String>,
) -> Result<PathBuf, String> {
    let lib = result.inspect_err(|e| log::warn!("{e}"))?;
    let root = lib.root.clone();
    if let Err(e) = recent::push(&recent_file(app)?, &root) {
        // 一覧に残せなくてもライブラリは使えるので、開く処理は止めない
        log::error!("最近使ったライブラリを保存できません：{e}");
    }
    *current.0.lock().unwrap() = Some(lib);
    log::info!("ライブラリを開きました：{}", root.display());
    Ok(root)
}

#[tauri::command]
fn list_recent_libraries(app: AppHandle) -> Result<Vec<PathBuf>, String> {
    Ok(recent::load(&recent_file(&app)?))
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

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(Current::default())
        .invoke_handler(tauri::generate_handler![
            list_recent_libraries,
            location_warning,
            create_library,
            open_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
