mod backfill;
pub mod board;
mod calc;
mod category;
mod features;
mod fileops;
mod gallery;
mod import;
mod library;
mod manifest;
mod menu;
mod merge;
mod model;
mod origin;
mod recent;
mod restore;
mod settings;
mod settle;
mod similar;
mod skipped;
mod source;
mod sync;
mod tag;
mod terminate;
mod trash;
mod windows;
mod worker;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use library::{Access, Library};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};

/// アイデアボードの専用ウィンドウのラベル。同時に開くのは1つだけ（FR-701）
const BOARD: &str = "board";

// 開いているライブラリ。後のタスクのコマンドはここから DB を使う。特徴量の計算のスレッドも同じものを持つ
#[derive(Default)]
struct Current(Arc<Mutex<Option<Library>>>);

/// 起動時に1回読んだ `ml/model.json`。読めなければその理由を持ち、類似画像検索を使えなくする
struct Models(Result<manifest::Manifest, String>);

impl Models {
    fn manifest(&self) -> Result<&manifest::Manifest, String> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

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

/// `ml/model.json` の場所。リリース版は `.app` に同梱した写し
fn manifest_file(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(concat!(env!("CARGO_MANIFEST_DIR"), "/../ml/model.json").into());
    }
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("worker/model.json"))
}

/// ワーカーの起動の仕方。開発版は ml/.venv の Python、リリース版は `.app` に同梱した実行ファイル
fn worker_spec(app: &AppHandle) -> Result<worker::Spec, String> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    let program = if cfg!(debug_assertions) {
        let python = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../ml/.venv/bin/python"
        ));
        if !python.exists() {
            return Err(format!(
                "ワーカーの Python がありません（{}）。ml/ で uv sync を実行してください",
                python.display()
            ));
        }
        args.extend(["-m".into(), "kura_worker".into()]);
        python
    } else {
        let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        dir.join("worker/kura-worker")
    };
    args.extend([
        "--manifest".into(),
        manifest_file(app)?.into(),
        "--model-dir".into(),
        app_file(app, "models")?.into(),
    ]);
    Ok(worker::Spec { program, args })
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
    for name in [
        "kura.db",
        "kura.db-wal",
        "kura.db-shm",
        "features.db",
        "features.db-wal",
        "features.db-shm",
    ] {
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
    windows::close_board(app);
    log::info!("ライブラリを開きました：{}", root.display());
    app.state::<calc::Calc>().wake();
    // 前のライブラリの組を探し続けない
    app.state::<origin::Search>().cancel();
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
        Some(windows::settle(&app, &[BOARD]).await?)
    };
    let mut similarity = None;
    settings::save_and_apply(&settings_file(&app)?, &settings, |before, after| {
        similarity = Some((before.similarity_enabled, after.similarity_enabled));
        if after.board_enabled == before.board_enabled
            && after.similarity_enabled == before.similarity_enabled
        {
            return Ok(());
        }
        // OFF ではボードの項目と ⌘B をメニューから外し、開いているボードを閉じる（FR-711）。
        // 類似画像検索が OFF なら、その項目と ⇧⌘F を外す（6章）
        menu::build(&app, after.board_enabled, after.similarity_enabled)
            .and_then(|m| app.set_menu(m))
            .map_err(|e| format!("メニューを変えられません（{e}）"))?;
        // 作り直した項目は無効で始まるので、今のギャラリーの状態を当て直す
        windows::update_gallery(&app, |_| {});
        if !after.board_enabled {
            windows::close_board(&app);
        }
        Ok(())
    })?;
    // 設定を前の値に戻したときに合図だけが届かないよう、保存できてから知らせる
    match similarity {
        Some((false, true)) => app.state::<calc::Calc>().wake(),
        Some((true, false)) => app.state::<calc::Calc>().halt(),
        _ => {}
    }
    Ok(())
}

/// 類似画像検索を ON にする前の確認で見せる、モデルの大きさ（バイト）
#[tauri::command]
fn model_size(models: State<Models>) -> Result<u64, String> {
    Ok(model::size(models.manifest()?))
}

/// モデルのファイルが欠けている観点と、そのダウンロードの大きさ。通信しない。
/// 3a から更新した利用者に、設定でポーズのモデルの「ダウンロード」を出すために使う
#[tauri::command]
fn missing_models(app: AppHandle, models: State<Models>) -> Result<model::Missing, String> {
    Ok(model::missing(
        models.manifest()?,
        &app_file(&app, "models")?,
    ))
}

/// 類似画像検索のモデルを app_file(app, "models") にそろえ、進み具合を model-progress で知らせる。
/// similarity_enabled は、これが Ok を返した後に画面が save_settings で true にする。
/// モデルがそろう前に ON を保存すると、計算を始める側がモデルのない状態を見るため。
/// そろえたら計算を起こす。ON のまま足りないモデルを取得したときは、save_settings のきっかけがないため
#[tauri::command]
async fn prepare_models(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = app.state::<Models>().manifest()?.clone();
        let dir = app_file(&app, "models")?;
        model::prepare(&dir, &model::files(&manifest), |done, total| {
            let p = ImportProgress {
                done: done as usize,
                total: total as usize,
            };
            if let Err(e) = app.emit_to("main", "model-progress", p) {
                log::warn!("モデルのダウンロードの進み具合を送れません：{e}");
            }
        })?;
        log::info!("モデルをそろえました：{}", dir.display());
        app.state::<calc::Calc>().wake();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 特徴量の計算の状況。画面を開いたときと、設定を開いたときに呼ぶ
#[tauri::command]
fn features_status(calc: State<calc::Calc>) -> calc::Status {
    calc.status()
}

/// 設定の「再計算」。計算できなかった画像と未計算の画像をもう一度計算する。計算済みは消さない
#[tauri::command]
fn retry_features(calc: State<calc::Calc>) {
    calc.retry();
}

/// 基準画像に対する観点ごとの類似度。重みを掛けて並べるのは画面
#[tauri::command]
fn similar_images(
    app: AppHandle,
    current: State<Current>,
    models: State<Models>,
    id: i64,
) -> Result<similar::Similar, String> {
    let manifest = models.manifest()?;
    let missing = model::missing(manifest, &app_file(&app, "models")?).aspects;
    let start = std::time::Instant::now();
    let result = current
        .0
        .with(|lib| similar::similar(lib, &manifest.aspects, id, &missing))?;
    log::info!(
        "類似度を計算しました（{}枚、未計算 {}枚、{:?}）",
        result.ids.len(),
        result.uncomputed,
        start.elapsed()
    );
    Ok(result)
}

/// ライブラリの外の画像を基準にした類似度と、帯に出すサムネイル（FR-608）
#[derive(Serialize)]
struct SimilarToFile {
    #[serde(flatten)]
    similar: similar::Similar,
    /// サムネイルの JPEG のバイト列。一時フォルダは消すので、ファイルの場所でなく中身を渡す
    thumb: Vec<u8>,
}

/// ライブラリの外の画像 path を基準に探す（FR-608）。取り込まず、ライブラリに何も書かない。
/// ワーカーの起動を待つ間に画面を止めないよう、別のスレッドで計算する
#[tauri::command]
async fn similar_to_file(app: AppHandle, path: PathBuf) -> Result<SimilarToFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let aspects = app.state::<Models>().manifest()?.aspects.clone();
        let temp = app.path().temp_dir().map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        let (similar, thumb) = similar::search_file(
            &*app.state::<Current>().0,
            &app.state::<calc::Calc>(),
            &aspects,
            &path,
            &temp,
        )
        .inspect_err(|e| {
            log::warn!(
                "ライブラリの外の画像で探せません（{}、{e}）",
                path.display()
            )
        })?;
        log::info!(
            "ライブラリの外の画像で探しました（{}枚、未計算 {}枚、{:?}）",
            similar.ids.len(),
            similar.uncomputed,
            start.elapsed()
        );
        Ok(SimilarToFile { similar, thumb })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 拡大表示に重ねる、画像の今のモデルのポーズ（FR-606）
#[tauri::command]
fn image_pose(
    app: AppHandle,
    current: State<Current>,
    models: State<Models>,
    id: i64,
) -> Result<similar::PoseOf, String> {
    let manifest = models.manifest()?;
    let missing = model::missing(manifest, &app_file(&app, "models")?).aspects;
    current
        .0
        .with(|lib| similar::pose_of(lib, &manifest.aspects, id, &missing))
        // 画面は切り替えを出さないだけなので、理由はログに残す
        .inspect_err(|e| log::warn!("ポーズを読めません（{id}、{e}）"))
}

/// ライブラリ全体から元が同じ画像の組を探す（FR-611）。進み具合を origin-progress で知らせる。
/// ロックは特徴量を読む間だけ持つので、探している間もほかのコマンドを使える。中止されたら null
#[tauri::command]
async fn find_origin_groups(app: AppHandle) -> Result<Option<Vec<Vec<i64>>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let aspects = app.state::<Models>().manifest()?.aspects.clone();
        let start = std::time::Instant::now();
        let groups = origin::find(
            &*app.state::<Current>().0,
            &app.state::<origin::Search>(),
            &aspects,
            &mut |p| {
                if let Err(e) = app.emit_to("main", "origin-progress", p) {
                    log::warn!("元が同じ画像を探す進み具合を送れません：{e}");
                }
            },
        )?;
        match &groups {
            Some(g) => log::info!(
                "元が同じ画像の組を探しました（{}組、{:?}）",
                g.len(),
                start.elapsed()
            ),
            None => log::info!("元が同じ画像の組を探すのを中止しました"),
        }
        Ok(groups)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 元が同じ画像の組を探すのを止める（FR-611）
#[tauri::command]
fn cancel_origin_groups(search: State<origin::Search>) {
    search.cancel();
}

/// 特徴量の計算が使うもの。ワーカーは計算する画像があるときだけ、回ごとに起動する
fn calc_env(app: &AppHandle, manifest: Option<manifest::Manifest>) -> calc::Env {
    let aspects = manifest
        .as_ref()
        .map(|m| m.aspects.clone())
        .unwrap_or_default();
    let (a, b, c, d) = (app.clone(), app.clone(), app.clone(), app.clone());
    let loaded = manifest.is_some();
    calc::Env {
        // model.json を読めなければ、設定によらず使えない。モデルのファイルは観点ごとに available で見る
        enabled: Box::new(move || {
            loaded && settings_file(&a).is_ok_and(|f| settings::load(&f).similarity_enabled)
        }),
        aspects,
        available: Box::new(move |aspect| {
            app_file(&d, "models").is_ok_and(|dir| model::available(&dir, aspect))
        }),
        start: Box::new(move |usable| {
            let spec = worker_spec(&b)?;
            let timeouts = worker::Timeouts {
                ready: std::time::Duration::from_secs(60),
                reply: std::time::Duration::from_secs(30),
            };
            let w = worker::Worker::start(&spec, usable, timeouts)?;
            Ok(Box::new(w) as Box<dyn calc::Compute>)
        }),
        notify: Box::new(move |s| {
            if let Err(e) = c.emit_to("main", "features-progress", s) {
                log::warn!("特徴量の計算の進み具合を送れません：{e}");
            }
        }),
    }
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

/// 一覧からドラッグした画像を、開いているボードの落とした点に置く（FR-713）。編集は続く
#[tauri::command]
fn drop_on_board(
    current: State<Current>,
    edit: board::Edit,
    revision: u64,
    images: Vec<i64>,
    at: board::Point,
) -> Result<board::EditingBoard, String> {
    let dropped = current
        .0
        .with(|lib| board::drop_images(lib, edit, revision, &images, at))?;
    log::info!(
        "ボードにドロップしました：ボード {}、{}枚",
        edit.board_id.0,
        images.len()
    );
    Ok(dropped)
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
    let _held = windows::settle(&app, &[BOARD])
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
    windows::show_board_window(app.clone()).await?;
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
    calc: State<calc::Calc>,
    path: PathBuf,
) -> Result<PathBuf, String> {
    release(&current, &calc);
    activate(&app, &current, library::create(&path))
}

#[tauri::command]
fn open_library(
    app: AppHandle,
    current: State<Current>,
    calc: State<calc::Calc>,
    path: PathBuf,
) -> Result<PathBuf, String> {
    release(&current, &calc);
    activate(&app, &current, library::open(&path))
}

/// 開いているライブラリを閉じ、DB の排他ロックを外す。同じライブラリを選び直しても開けるように、
/// 次のライブラリを開く前に閉じる。選択画面には前のライブラリへ戻る操作がないので、残しておく必要はない
fn release(current: &Current, calc: &calc::Calc) {
    // 前のライブラリの計算を止める。計算のスレッドは書く直前に止められたことに気づき、書かずに抜ける
    calc.halt();
    current
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
}

#[tauri::command]
fn load_gallery(current: State<Current>) -> Result<gallery::Gallery, String> {
    current.0.with(|lib| gallery::load(lib))
}

#[tauri::command]
fn image_detail(
    current: State<Current>,
    models: State<Models>,
    id: i64,
) -> Result<gallery::Detail, String> {
    current.0.with(|lib| {
        let mut detail = gallery::detail(lib, id)?;
        // 特徴量を読めなくても詳細は出す。基準にできないものとして扱い、理由はログに残す
        detail.similar = models
            .manifest()
            .and_then(|m| similar::ready(lib, &m.aspects, id))
            .unwrap_or_else(|e| {
                log::warn!("類似検索できるかを確かめられません（{id}、{e}）");
                false
            });
        Ok(detail)
    })
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

/// 元が同じ画像を1枚にまとめる（FR-610）。配置を置き換えるので、先に開いているボードの保存を待つ。
/// 置き換えたら、開いているボードに開き直させる。取り消しの履歴を直せるよう、置き換えた参照を渡す
#[tauri::command]
async fn merge_images(
    app: AppHandle,
    keep: i64,
    remove: Vec<i64>,
    category: Option<i64>,
    tags: Vec<i64>,
) -> Result<merge::Merged, String> {
    let _held = windows::settle(&app, &[BOARD])
        .await
        .map_err(|e| format!("ボードを保存できないため、まとめられません（{e}）"))?;
    let merged = with_library(app.clone(), move |lib| {
        merge::merge(lib, keep, &remove, category, &tags)
    })
    .await?;
    log::info!(
        "1枚にまとめました：残す画像 {keep}、ゴミ箱 {}枚、移せない画像 {}枚、ボード {}件",
        merged.trashed.len(),
        merged.failed.len(),
        merged.boards.len()
    );
    if !merged.boards.is_empty() {
        if let Err(e) = app.emit_to(BOARD, "board-replaced", &merged.replaced) {
            log::warn!("ボードに配置の置き換えを知らせられません：{e}");
        }
    }
    Ok(merged)
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
        let r = sync::scan(&*current.0, |done, total| {
            if let Err(e) = app.emit("scan-progress", ImportProgress { done, total }) {
                log::warn!("差分検出の進み具合を送れません：{e}");
            }
        })
        .and_then(|mut r| {
            // ON の間は、対応していない形式のファイルを差分検出のたびに移す（FR-108）。読めない設定は初期値（OFF）とみなす
            if settings_file(&app).is_ok_and(|f| settings::load(&f).set_aside_unsupported) {
                current.0.with(|lib| {
                    skipped::set_aside(lib, &mut r.skipped);
                    Ok(())
                })?;
            }
            Ok(r)
        });
        // 一部だけ登録した失敗もあるので、結果によらず計算を起こす
        app.state::<calc::Calc>().wake();
        let r = r?;
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

/// 差分検出のスキップの一覧から、対応していない形式のファイルを `_未対応ファイル/` へ移す（FR-108）。
/// 返り値は paths と同じ順の、移した先か移せなかった理由
#[tauri::command]
async fn set_aside_unsupported(
    app: AppHandle,
    paths: Vec<PathBuf>,
) -> Result<Vec<import::Skipped>, String> {
    with_library(app, move |lib| {
        let mut list: Vec<_> = paths
            .into_iter()
            .map(|path| import::Skipped {
                path,
                reason: import::Reason::Unsupported,
            })
            .collect();
        skipped::set_aside(lib, &mut list);
        Ok(list)
    })
    .await
}

/// 差分検出で重複として登録しなかったファイル path を整理する（FR-109）。
/// keep_registered が false なら、登録済みの画像 existing をそのファイルのあったカテゴリへ移す
#[tauri::command]
async fn tidy_duplicate(
    app: AppHandle,
    path: PathBuf,
    existing: i64,
    keep_registered: bool,
) -> Result<(), String> {
    with_library(app, move |lib| {
        skipped::tidy(lib, &path, existing, keep_registered)
    })
    .await
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

/// 選んだ管理情報を確かめる（FR-107）。戻す前の確認ダイアログに、日時と枚数と警告を出すため
#[tauri::command]
async fn inspect_backup(app: AppHandle, path: PathBuf) -> Result<restore::Inspected, String> {
    with_library(app, move |lib| restore::inspect(lib, &path)).await
}

/// 管理情報を戻す（FR-107、ADR-0032）。画面がメモとボードを保存してボードを閉じてから呼ぶ（ライブラリの
/// 切り替えと同じ）。元URLの補完が終わるのを待ち、特徴量の計算を止めてから置き換え、同じライブラリを開き直す
#[tauri::command]
async fn restore_library(app: AppHandle, path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _wait = app.state::<backfill::Gate>().inner().wait();
        let calc = app.state::<calc::Calc>();
        // halt ではなく pause で止める。halt は止めた直後に次の回を計画するため（Calc::pause）
        calc.pause();
        let current = app.state::<Current>();
        let mut slot = current.0.lock().unwrap_or_else(PoisonError::into_inner);
        let result = restore::restore(&mut slot, &path);
        match &result {
            Ok(()) => log::info!("管理情報を戻しました：{}", path.display()),
            Err(e) => log::warn!("管理情報を戻せません：{e}"),
        }
        // 戻せたときは計算を起こさない。開き直した画面の差分検出が画像を登録し直し、終わったときに起こす。
        // 戻せなかったときは画面を作り直さないので、ここで起こす
        if result.is_err() && slot.is_some() {
            calc.wake();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
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
            .run(&*app.state::<Current>().0, |c| {
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
    // ゴミ箱から戻した画像を計算し、ゴミ箱・完全削除・「一覧から外す」の後の数を合わせ直す
    handle.state::<calc::Calc>().wake();
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
        let report = import::import_paths(&*current.0, &paths, category, |done, total| {
            if let Err(e) = app.emit("import-progress", ImportProgress { done, total }) {
                log::warn!("取り込みの進み具合を送れません：{e}");
            }
        });
        app.state::<calc::Calc>().wake();
        let report = report?;
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
            let models = manifest_file(app.handle()).and_then(|f| manifest::read(&f));
            if let Err(e) = &models {
                log::error!("model.json を読めないため、類似画像検索を使えません：{e}");
            }
            let env = calc_env(app.handle(), models.clone().ok());
            let lib = app.state::<Current>().0.clone();
            app.manage(calc::Calc::spawn(env, lib));
            app.manage(Models(models));
            Ok(())
        })
        .menu(|app| {
            let s = settings_file(app)
                .map(|file| settings::load(&file))
                .unwrap_or_default();
            menu::build(app, s.board_enabled, s.similarity_enabled)
        })
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT {
                windows::quit(app);
                return;
            }
            // 「編集」の項目は手前のウィンドウに効かせる。メニューを開いても手前のウィンドウは変わらない（NFR-12）
            if let Some(edit) = menu::EDITS.iter().find(|id| event.id() == **id) {
                let front = app
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false));
                if let Some(w) = front {
                    if let Err(e) = app.emit_to(w.label(), "edit-menu", edit) {
                        log::warn!("メニューの操作を画面に送れません（{edit}）：{e}");
                    }
                }
                return;
            }
            // 開いているライブラリ（Current）は次のライブラリを開くまで残す。戻るかどうかは画面が決める。
            // ボードもギャラリーの画面が開く。ライブラリ選択画面ではボードを開かないため
            for id in [
                menu::SWITCH_LIBRARY,
                menu::OPEN_BOARD,
                menu::ADD_TO_BOARD,
                menu::FIND_SIMILAR,
                menu::FIND_ORIGIN_GROUPS,
            ] {
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
                    windows::close_board_after_save(window.app_handle());
                } else {
                    windows::quit(window.app_handle());
                }
            }
            WindowEvent::Focused(focused) if window.label() == "main" => {
                windows::update_gallery(window.app_handle(), |g| g.front = *focused);
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) if window.label() == BOARD => {
                windows::track_board_frame(window);
            }
            WindowEvent::Destroyed => {
                if window.label() == BOARD {
                    windows::remember_board_frame(window.app_handle());
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
        .manage(windows::BoardFrame::default())
        .manage(Mutex::new(windows::GalleryState::default()))
        .manage(backfill::Gate::default())
        .manage(origin::Search::default())
        .invoke_handler(tauri::generate_handler![
            list_recent_libraries,
            missing_recent_libraries,
            forget_recent_library,
            load_settings,
            save_settings,
            model_size,
            missing_models,
            prepare_models,
            features_status,
            similar_images,
            similar_to_file,
            image_pose,
            find_origin_groups,
            cancel_origin_groups,
            retry_features,
            windows::report_gallery,
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
            merge_images,
            restore_images,
            purge_images,
            empty_trash,
            load_missing,
            scan_library,
            set_aside_unsupported,
            tidy_duplicate,
            forget_images,
            backup_library,
            inspect_backup,
            restore_library,
            backfill_sources,
            cancel_backfill,
            windows::show_board_window,
            windows::set_board_display,
            list_boards,
            open_board,
            create_board,
            rename_board,
            delete_board,
            save_board,
            add_to_board,
            drop_on_board,
            take_board_reveal,
            board_sources,
            show_in_gallery,
            windows::flush_ready,
            windows::flush_done,
            windows::close_board_window
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
            ".kura/features.db",
            ".kura/features.db-wal",
            ".kura/features.db-shm",
            ".kura/trash/1.jpg",
        ] {
            assert!(!scope.is_allowed(root.join(ng)), "{ng}");
        }
        assert!(!scope.is_allowed("/Volumes/外付け/a.jpg"));
    }
}
