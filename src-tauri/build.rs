fn main() {
    // tauri dev と cargo test はワーカーをビルドしないが、bundle.resources の場所がないと tauri_build が止まる
    std::fs::create_dir_all("../ml/dist/kura-worker").expect("ml/dist/kura-worker を作れません");
    tauri_build::build()
}
