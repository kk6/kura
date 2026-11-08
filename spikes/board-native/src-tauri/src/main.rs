use objc2_app_kit::NSWindow;
use std::{fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex, time::Duration};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

#[derive(Clone, Copy, Debug)]
enum Intent {
    Board,
    Off,
    Exit,
}

#[derive(Default)]
enum Phase {
    #[default]
    Editing,
    Saving,
    ExitApproved,
}

#[derive(Default)]
struct Probe {
    phase: Phase,
    revision: u64,
    fail: bool,
    top: bool,
}

fn directory() -> PathBuf {
    PathBuf::from(std::env::var_os("SPIKE_RUN_DIR").expect("use run.sh"))
}

fn record(message: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory().join("events.log"))
        .unwrap();
    writeln!(file, "{message}").unwrap();
}

fn notify(app: &AppHandle, message: &str) {
    record(message);
    app.emit("status", message).unwrap();
}

fn request(app: &AppHandle, intent: Intent) {
    let state = app.state::<Mutex<Probe>>();
    let mut probe = state.lock().unwrap();
    if !matches!(probe.phase, Phase::Editing) {
        return;
    }
    probe.phase = Phase::Saving;
    let (revision, fail) = (probe.revision, probe.fail);
    drop(probe);
    notify(
        app,
        &format!("保存中 revision={revision} intent={intent:?}"),
    );
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let result = if fail {
            Err(std::io::Error::other("人工の保存失敗"))
        } else {
            std::fs::write(
                directory().join("snapshot.tmp"),
                format!("人工配置 revision={revision}\n"),
            )
            .and_then(|_| {
                std::fs::rename(
                    directory().join("snapshot.tmp"),
                    directory().join("snapshot.txt"),
                )
            })
        };
        let callback_app = app.clone();
        app.run_on_main_thread(move || {
            let app = callback_app;
            if let Err(error) = result {
                app.state::<Mutex<Probe>>().lock().unwrap().phase = Phase::Editing;
                notify(
                    &app,
                    &format!("保存できませんでした・遷移中止 revision={revision} {error}"),
                );
                return;
            }
            notify(
                &app,
                &format!("保存済み revision={revision} intent={intent:?}"),
            );
            match intent {
                Intent::Board | Intent::Off => {
                    if let Some(board) = app.get_webview_window("board") {
                        board.destroy().unwrap();
                    }
                    app.state::<Mutex<Probe>>().lock().unwrap().phase = Phase::Editing;
                    notify(&app, "ボードのみ終了・ギャラリーは継続");
                }
                Intent::Exit => {
                    app.state::<Mutex<Probe>>().lock().unwrap().phase = Phase::ExitApproved;
                    app.exit(0);
                }
            }
        })
        .unwrap();
    });
}

#[tauri::command]
fn act(app: AppHandle, action: String) -> Result<String, String> {
    if action == "off" {
        request(&app, Intent::Off);
        return Ok("保存待ち".into());
    }
    let state = app.state::<Mutex<Probe>>();
    let mut probe = state.lock().unwrap();
    if !matches!(probe.phase, Phase::Editing) {
        return Err("保存待ち中・編集停止".into());
    }
    match action.as_str() {
        "edit" => probe.revision += 1,
        "failure" => probe.fail = !probe.fail,
        "top" => {
            let top = !probe.top;
            app.get_webview_window("board")
                .ok_or("ボードを開いてください")?
                .set_always_on_top(top)
                .map_err(|e| e.to_string())?;
            probe.top = top;
        }
        "30" | "65" | "100" => {
            let value = action.parse::<f64>().unwrap() / 100.0;
            let board = app
                .get_webview_window("board")
                .ok_or("ボードを開いてください")?;
            board
                .clone()
                .run_on_main_thread(move || {
                    // Tauri owns the NSWindow. Resolve and use its pointer only on the main thread.
                    let native = unsafe { &*board.ns_window().unwrap().cast::<NSWindow>() };
                    native.setAlphaValue(value);
                    record(&format!(
                        "native alpha={} ignoresMouseEvents={}",
                        native.alphaValue(),
                        native.ignoresMouseEvents()
                    ));
                })
                .map_err(|e| e.to_string())?;
        }
        "open" => {
            if let Some(board) = app.get_webview_window("board") {
                board.set_focus().unwrap();
            } else {
                tauri::WebviewWindowBuilder::new(
                    &app,
                    "board",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("人工ボード・タスク0")
                .inner_size(600.0, 500.0)
                .always_on_top(probe.top)
                .build()
                .map_err(|e| e.to_string())?;
            }
        }
        "status" => (),
        _ => return Err("未知の操作".into()),
    }
    let message = format!(
        "人工配置 revision={} 保存失敗={} 最前面={}",
        probe.revision, probe.fail, probe.top
    );
    drop(probe);
    notify(&app, &message);
    Ok(message)
}

fn main() {
    assert!(directory().is_dir(), "use run.sh");
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    assert_eq!(home, directory().join("home"));
    record(&format!("isolated HOME={}", home.display()));
    tauri::Builder::default()
        .menu(|app| {
            let quit =
                MenuItem::with_id(app, "save-quit", "保存して終了", true, Some("CmdOrCtrl+Q"))?;
            let close = PredefinedMenuItem::close_window(app, Some("閉じる"))?;
            Menu::with_items(
                app,
                &[
                    &Submenu::with_items(app, "Kura Native Spike", true, &[&quit])?,
                    &Submenu::with_items(app, "ファイル", true, &[&close])?,
                ],
            )
        })
        .on_menu_event(|app, event| {
            if event.id() == "save-quit" {
                record("Menu save-quit");
                request(app, Intent::Exit);
            }
        })
        .manage(Mutex::new(Probe::default()))
        .invoke_handler(tauri::generate_handler![act])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                record(&format!("CloseRequested {}", window.label()));
                request(
                    window.app_handle(),
                    if window.label() == "board" {
                        Intent::Board
                    } else {
                        Intent::Exit
                    },
                );
            }
        })
        .build(tauri::generate_context!())
        .expect("build spike")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                record(&format!("ExitRequested code={code:?}"));
                let approved = matches!(
                    app.state::<Mutex<Probe>>().lock().unwrap().phase,
                    Phase::ExitApproved
                );
                if !approved {
                    api.prevent_exit();
                    request(app, Intent::Exit);
                }
            }
        });
}
