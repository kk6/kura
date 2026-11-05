mod category;
mod fileops;
mod gallery;
mod import;
mod library;
mod recent;
mod settings;
mod sync;
mod tag;
mod trash;

use std::path::PathBuf;
use std::sync::Mutex;

use library::Library;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

// 開いているライブラリ。後のタスクのコマンドはここから DB を使う
#[derive(Default)]
struct Current(Mutex<Option<Library>>);

fn app_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(name))
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
fn load_settings(app: AppHandle) -> Result<settings::Settings, String> {
    Ok(settings::load(&app_file(&app, "settings.json")?))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    settings::save(&app_file(&app, "settings.json")?, &settings)
        .map_err(|e| format!("設定を保存できません（{e}）"))
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

/// 画像を移すので、取り込みと同じく別のスレッドで行う（同期のコマンドは画面のスレッドを止める）
#[tauri::command]
async fn set_category(
    app: AppHandle,
    ids: Vec<i64>,
    category: Option<i64>,
) -> Result<category::Assigned, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        let lib = current.as_mut().ok_or("ライブラリを開いていません")?;
        let result = category::assign(lib, &ids, category)?;
        for f in &result.failed {
            log::warn!("画像 {} のカテゴリを変えられません：{}", f.id, f.message);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// parent の下（None はルート直下）にカテゴリとフォルダを作る（FR-401）。返り値は新しいカテゴリの id
#[tauri::command]
async fn create_category(app: AppHandle, parent: Option<i64>, name: String) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        category::create(
            current.as_mut().ok_or("ライブラリを開いていません")?,
            parent,
            &name,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画像のファイル名を変える（FR-410）。stem は拡張子より前の部分。返り値は変えた後のファイル名
#[tauri::command]
async fn rename_image(app: AppHandle, id: i64, stem: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        category::rename_image(
            current.as_mut().ok_or("ライブラリを開いていません")?,
            id,
            &stem,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// フォルダの名前を変えたり移したりするので、set_category と同じく別のスレッドで行う
#[tauri::command]
async fn rename_category(app: AppHandle, id: i64, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        category::rename(
            current.as_mut().ok_or("ライブラリを開いていません")?,
            id,
            &name,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn move_category(app: AppHandle, id: i64, parent: Option<i64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        category::move_to(
            current.as_mut().ok_or("ライブラリを開いていません")?,
            id,
            parent,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_category(app: AppHandle, id: i64) -> Result<category::Deleted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        category::delete(current.as_mut().ok_or("ライブラリを開いていません")?, id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_categories_collapsed(
    current: State<Current>,
    ids: Vec<i64>,
    collapsed: bool,
) -> Result<(), String> {
    let current = current.0.lock().unwrap();
    category::set_collapsed(
        current.as_ref().ok_or("ライブラリを開いていません")?,
        &ids,
        collapsed,
    )
}

#[tauri::command]
fn image_tags(current: State<Current>, ids: Vec<i64>) -> Result<Vec<tag::Counted>, String> {
    let current = current.0.lock().unwrap();
    tag::of(current.as_ref().ok_or("ライブラリを開いていません")?, &ids)
}

#[tauri::command]
fn add_tag(current: State<Current>, ids: Vec<i64>, name: String) -> Result<gallery::Tag, String> {
    let mut current = current.0.lock().unwrap();
    tag::add(
        current.as_mut().ok_or("ライブラリを開いていません")?,
        &ids,
        &name,
    )
}

#[tauri::command]
fn remove_tag(current: State<Current>, ids: Vec<i64>, tag_id: i64) -> Result<(), String> {
    let current = current.0.lock().unwrap();
    tag::remove(
        current.as_ref().ok_or("ライブラリを開いていません")?,
        &ids,
        tag_id,
    )
}

#[tauri::command]
fn rename_tag(current: State<Current>, id: i64, name: String) -> Result<gallery::Tag, String> {
    let current = current.0.lock().unwrap();
    tag::rename(
        current.as_ref().ok_or("ライブラリを開いていません")?,
        id,
        &name,
    )
}

#[tauri::command]
fn merge_tag(current: State<Current>, from: i64, into: i64) -> Result<(), String> {
    let mut current = current.0.lock().unwrap();
    tag::merge(
        current.as_mut().ok_or("ライブラリを開いていません")?,
        from,
        into,
    )
}

#[tauri::command]
fn delete_tag(current: State<Current>, id: i64) -> Result<(), String> {
    let mut current = current.0.lock().unwrap();
    tag::delete(current.as_mut().ok_or("ライブラリを開いていません")?, id)
}

#[tauri::command]
fn load_trash(current: State<Current>) -> Result<Vec<gallery::Image>, String> {
    let current = current.0.lock().unwrap();
    gallery::trash(current.as_ref().ok_or("ライブラリを開いていません")?)
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
    let current = current.0.lock().unwrap();
    gallery::missing(current.as_ref().ok_or("ライブラリを開いていません")?)
}

/// 差分検出（FR-104）。画面がライブラリを開いた後と、利用者がボタンを押したときに呼ぶ。
/// 進み具合を scan-progress イベントで知らせる。1枚ごとにロックを外すので、その間も他のコマンドを使える
#[tauri::command]
async fn scan_library(app: AppHandle) -> Result<sync::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

async fn with_library<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Library) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.state::<Current>();
        let mut current = current.0.lock().unwrap();
        f(current.as_mut().ok_or("ライブラリを開いていません")?)
    })
    .await
    .map_err(|e| e.to_string())?
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
            load_settings,
            save_settings,
            location_warning,
            create_library,
            open_library,
            import_paths,
            load_gallery,
            image_detail,
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
            backup_library
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
