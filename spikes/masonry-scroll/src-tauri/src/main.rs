//! スパイク：2万枚のサムネイルを仮想スクロールのメイソンリーで表示する。
//! SPIKE_BENCH=1 で起動すると自動でスクロールして計測し、結果のJSONを標準出力に出して終了する。
//! SPIKE_COL=<列の目安の幅px>（既定 200）

#[derive(serde::Serialize)]
struct Config {
    data_dir: String,
    bench: bool,
    col: u32,
}

#[tauri::command]
fn config() -> Config {
    Config {
        // shortcut: ビルド時のパスに固定。スパイク専用
        // `..` を含むパスはアセットの読み込み範囲（scope）の判定に通らないので正規化する
        data_dir: std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../.data")).unwrap().to_string_lossy().into_owned(),
        bench: std::env::var("SPIKE_BENCH").is_ok(),
        col: std::env::var("SPIKE_COL").ok().and_then(|v| v.parse().ok()).unwrap_or(200),
    }
}

#[tauri::command]
fn report(app: tauri::AppHandle, json: String) {
    println!("{json}");
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![config, report])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
