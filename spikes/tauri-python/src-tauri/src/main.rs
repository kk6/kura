//! スパイク：Tauri から Python のワーカー（サイドカー）を起動し、画像のパスを渡して結果を受け取る。
//!
//! SPIKE_IMAGE=<画像のパス> を付けて起動すると、ワーカーに同じ画像を3回渡し、
//! 起動からの経過時間付きで結果を標準出力に出して終了する。
use std::time::Instant;
use tauri::Manager;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let Ok(image) = std::env::var("SPIKE_IMAGE") else { return Ok(()) };
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let started = Instant::now();
                // SPIKE_MODE=onedir：resources に同梱したフォルダ形式のワーカーを起動する（毎回の展開がない）
                let command = if std::env::var("SPIKE_MODE").as_deref() == Ok("onedir") {
                    let exe = handle.path().resource_dir().unwrap().join("worker/kura-worker");
                    handle.shell().command(exe)
                } else {
                    handle.shell().sidecar("kura-worker").unwrap()
                };
                let (mut rx, mut child) = command.spawn().unwrap();
                let path = serde_json::to_string(&image).unwrap();
                let mut sent = 0;
                while let Some(event) = rx.recv().await {
                    match event {
                        // 1行目は ready。結果が返るたびに次を送り、3件返ったら終わる
                        CommandEvent::Stdout(line) => {
                            println!("[{:>5} ms] {}", started.elapsed().as_millis(), String::from_utf8_lossy(&line).trim_end());
                            if sent == 3 {
                                child.kill().unwrap();
                                handle.exit(0);
                                break;
                            }
                            sent += 1;
                            child.write(format!("{{\"id\":{sent},\"path\":{path}}}\n").as_bytes()).unwrap();
                        }
                        CommandEvent::Stderr(line) => eprintln!("{}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Terminated(status) => {
                            eprintln!("worker terminated: {status:?}");
                            handle.exit(1);
                            break;
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
