# Rust 1.100.0 の導入判断

調査日：2026-11-13。対象：`a718695` の Kura、macOS arm64。

## 結論

Rust 1.100.0 への更新を妨げる問題は、今回のビルド・テストでは見つからなかった。現在の依存関係と edition 2021 のまま更新できる。新 API を使うための一括リファクタリングは勧めない。

調査では 1.100.0 を追加インストールし、`cargo +1.100.0` で検証した。アプリのソース、依存関係、ロックファイル、CI の設定は変更していない。調査の後、2026-11-13 に手元の `stable` を 1.100.0 に更新した。

## 実行した検証

`src-tauri/` で実行した。依存関係の更新を混ぜないため、ビルドと検査には `--locked --offline` を付けた。既存の `dist/` を使った。

| コマンド | 結果 |
| --- | --- |
| `cargo +1.100.0 fmt --check` | 成功 |
| `cargo +1.100.0 test --locked --offline` | 264件成功、失敗・無視なし |
| `cargo +1.100.0 clippy --locked --offline -- -D warnings` | 成功。現在の CI と同じ対象 |
| `cargo +1.100.0 build --release --locked --offline` | 成功。最適化した実行ファイルまでビルド |
| `cargo +1.100.0 clippy --locked --offline --all-targets -- -D warnings` | テストの既存指摘2件で失敗 |
| `cargo +stable clippy --locked --offline --all-targets -- -D warnings` | 1.99.1 でも同じ2件で失敗 |

追加の Clippy 検査が指摘したのは `src-tauri/src/recent.rs:105` と `:106` の `cloned_ref_to_slice_refs`。テストの比較で使う `[library.clone()]` は `std::slice::from_ref(&library)` にできる。1.100.0 の導入条件ではなく、別途行える小さな整理と判断した。

実アプリの起動・操作、Tauri の `.app` バンドル生成・署名、GitHub Actions 上での実行、別ファイルシステム上のテストは、この調査では未検証。

追加の確認（2026-11-13、`feat/phase2-release-prep` の `342f575`）：上の表の fmt、clippy、test（264件）、release ビルド、`--all-targets` の2件は同じ結果になった。`RUSTUP_TOOLCHAIN=1.100.0` で `npm run tauri build -- --bundles app` を実行し、リリース用の `.app` を作れた（実行ファイルに 1.100.0 のコミット `0ef1bc386` が入る）。この `.app` を `.claude/skills/verify-kura/` の手順で隔離して起動し、見本のライブラリを開いて差分の確認を終えた。DB の整合性は ok、`pending_ops` は空。画面の操作、署名、GitHub Actions、別ファイルシステムは引き続き未検証。テストには生成データと一時ディレクトリを使い、本物の資料フォルダには触れていない。

## 互換性で確認した点

[公式リリースノート](https://doc.rust-lang.org/releases.html#version-11000-2026-11-12) の互換性変更を、Kura の利用箇所と照合した。

- never 型の fallback が全 edition で `!` になり、`Infallible` も `!` の別名になる。Kura は edition 2021 なので確認対象になるが、既存の依存関係を含むテストと release ビルドは成功した。edition 2024 への移行は今回必要ない。
- `if let` を使うクロージャの捕捉、trait object の検査、`Box` の型推論にも変更がある。今回のコンパイルでは修正を要するエラーは出なかった。
- `ENOTSUP` の `ErrorKind` が `Unsupported` になる。`fileops.rs` の exFAT 向け分岐は `raw_os_error() == Some(libc::ENOTSUP)` を使っているため、この分類変更では分岐を失わない。
- 標準ライブラリの Unicode が 18.0.0 になる。`fileops::key` は NFC 正規化後に `to_lowercase()` するので、新しい Unicode 文字の扱いは影響しうる。既存テストの成功は、全 Unicode 文字と各ボリュームでの名前比較を保証するものではない。

Cargo は中間生成物の配置も変更する。Kura のリリーススクリプトと検証スクリプトは `target/release/bundle/macos/Kura.app` などの最終成果物を参照し、中間ファイルのハッシュや配置には依存していない。今回の Cargo ビルドは成功したが、Tauri のバンドル工程は別途確認が残る。[Cargo の変更履歴](https://doc.rust-lang.org/beta/cargo/CHANGELOG.html#cargo-1100-2026-11-12)

## 新機能を使って書き換える価値

[リリース記事](https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/) の新機能を、現在の実装に当てはめて判断した。

| 新機能 | Kura での判断 |
| --- | --- |
| `DropGuard` | `library::create_with` と `write_copy` の失敗時の後始末は候補。ただし既存処理は短く、今すぐ置き換える利益は小さい。関連処理を変更するときに再検討する |
| never 型 `!` | 本体に `Infallible` を使う API はなく、現在の `Result<_, String>` は実際に失敗する。変更不要 |
| `Allocator` API | 独自アロケータを必要とする測定結果がない。導入しない |
| `conjure_zst`、`UnsafeCell` の追加 API | 対応する処理がない。既存の FFI の `statfs` や関数ポインタ変換の代替にもならない |
| `trim_prefix`、`trim_suffix`、`Vec::from_fn`、`bool::toggle` など | 既存コードに置き換えるべき定型処理は見当たらない。今後、自然に使える箇所で使う |
| Cargo の未使用依存警告 | コード変更なしで恩恵を受ける。今回の既定 Clippy 検査とビルドでは未使用依存の警告は出なかった |
| Cargo の `min-publish-age` | 依存更新時の運用として検討できるが、リファクタリングとは別。既存のロック済み依存を再審査する機能ではないため、今回は設定しない |

`windows.rs` の `Held` と `settle.rs` の `Round` は、関数をまたいで保存待ちや編集停止の寿命を表す型になっている。`DropGuard` に置き換えても役割が明確になるとはいえず、維持する。

また、`DropGuard` はプロセス強制終了後の復旧を実現しない。画像移動の `pending_ops → rename → DB更新` を代替できない。ファイル移動の仕組みを新 API に合わせて変更する理由はない。

## 更新の扱い

`.github/workflows/ci.yml` は `dtolnay/rust-toolchain@stable`、`release.yml` は `rustup toolchain install stable` を使う。リポジトリに Rust の版を固定するファイルはないため、今後これらのジョブが stable を取得すると 1.100.0 が使われる。実際にどの CI 実行が更新済みかは今回確認していない。

ローカルも更新する場合は `rustup update stable` でよい。再現性のため版を固定する方針を採る場合は、`rust-toolchain.toml` と両ワークフローを合わせて扱う必要がある。今回の調査だけを理由に固定方式を変える必要はない。
