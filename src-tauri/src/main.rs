mod category;
mod fileops;
mod gallery;
mod import;
mod library;
mod recent;

use std::path::PathBuf;
use std::sync::Mutex;

use library::Library;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

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

/// 画面が直接読めるのは開いたライブラリの画像とサムネイルだけにし、DB とゴミ箱は読めないようにする
fn allow_assets<R: Runtime>(app: &AppHandle<R>, root: &std::path::Path) -> tauri::Result<()> {
    let scope = app.asset_protocol_scope();
    let kura = root.join(library::KURA_DIR);
    // ルートの ** は . で始まる .kura に入らないので、サムネイルは別に許可する。
    // DB とゴミ箱はそれに頼らず明示的に禁じる（forbid は allow より優先される）
    scope.allow_directory(root, true)?;
    scope.allow_directory(kura.join("thumbs"), true)?;
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

#[tauri::command]
fn load_gallery(current: State<Current>) -> Result<gallery::Gallery, String> {
    let current = current.0.lock().unwrap();
    gallery::load(current.as_ref().ok_or("ライブラリを開いていません")?)
}

#[tauri::command]
fn image_detail(current: State<Current>, id: i64) -> Result<gallery::Detail, String> {
    let current = current.0.lock().unwrap();
    gallery::detail(current.as_ref().ok_or("ライブラリを開いていません")?, id)
}

#[tauri::command]
fn set_memo(current: State<Current>, id: i64, memo: String) -> Result<(), String> {
    let current = current.0.lock().unwrap();
    gallery::set_memo(
        current.as_ref().ok_or("ライブラリを開いていません")?,
        id,
        &memo,
    )
}

#[tauri::command]
fn set_rating(current: State<Current>, id: i64, rating: i64) -> Result<(), String> {
    let current = current.0.lock().unwrap();
    gallery::set_rating(
        current.as_ref().ok_or("ライブラリを開いていません")?,
        id,
        rating,
    )
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
            import_paths,
            load_gallery,
            image_detail,
            set_memo,
            set_rating
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
