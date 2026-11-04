mod category;
mod fileops;
mod import;
mod library;
mod recent;

use std::path::PathBuf;
use std::sync::Mutex;

use library::Library;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

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
        .manage(Current::default())
        .invoke_handler(tauri::generate_handler![
            list_recent_libraries,
            location_warning,
            create_library,
            open_library,
            import_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
