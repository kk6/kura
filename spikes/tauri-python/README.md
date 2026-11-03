# スパイク1：Tauri から Python のワーカーを起動する

使い捨てのプロトタイプです。本体のコードには使いません。

## 確かめたかったこと

- Tauri 2 アプリから、uv で管理した Python のプロセスを起動し、画像のパスを渡して結果を受け取れるか
- 配布用のビルド（`.app`）に Python の処理を同梱し、uv や開発用の Python がない環境でも動くか

## 試した方法

- `ml/`：uv で管理した Python のプロジェクト（Pillow を使う）。標準入力から1行1件の JSON（`{"id", "path"}`）を受け取り、画像の幅・高さ・平均色を1行1件の JSON で標準出力に返す。最初に `{"ready": true}` を1行出す
- PyInstaller で、ワーカーを単体で動く形にした。次の2つの形を比べた
  - **onefile**：1つの実行ファイルにする。Tauri のサイドカー（`bundle.externalBin`）として同梱する
  - **onedir**：実行ファイルと `_internal/` のフォルダにする。Tauri の `bundle.resources` で `Contents/Resources/worker/` に同梱する
- Tauri 側（`src-tauri/src/main.rs`）は、`tauri-plugin-shell` でワーカーを起動し、同じ画像を3回渡して結果を受け取る
- `SPIKE_IMAGE=<画像>` を付けて `.app` の中の実行ファイルを起動すると、結果を出して終了する。`SPIKE_MODE=onedir` で onedir の形を使う

## 結果

環境：macOS 27.0.1（Appleシリコン）、Tauri CLI 2.12.4、Python 3.13.13、PyInstaller 6.22.3

| 項目 | onefile | onedir |
| --- | --- | --- |
| 起動から ready まで | 800〜900ms（初回は2.4秒） | 33〜46ms |
| 1件目の処理（Pillow の読み込みを含む） | 9〜14ms | 9〜12ms |
| 2件目以降の処理 | 約1ms | 約1ms |
| 同梱するファイルの大きさ | 13MB | 27MB |

- どちらの形も、ビルドした `.app` から起動し、結果を受け取れた
- `.app` を別のフォルダにコピーし、`PATH` を `/usr/bin:/bin` だけにして（uv がない状態で）起動しても動いた
- onefile は、起動のたびに中身を一時フォルダへ展開するので遅い。フェーズ3で機械学習のライブラリ（数百MB〜）が入ると、さらに遅くなる
- 画像が読めない場合も、ワーカーは止まらずにエラーを1件の結果として返した

### 気づいたこと

- サイドカーのバイナリ名（`kura-worker`）と resources のフォルダ名が同じだと、ビルド先で衝突してビルドが失敗する（`File exists (os error 17)`）
- Rust 側で `println!` の出力先が閉じられると、panic して処理が止まった。本体では、ワーカーとのやりとりで標準出力に書かない
- Tauri はアイコン（`src-tauri/icons/`）がないとビルドできない。ここでは `npm run icon` で単色のアイコンを生成している
- 署名は ad-hoc（`codesign` の Signature=adhoc）。自分の Mac で使う分には問題ない。他の人に配る場合は、ワーカーも含めて Developer ID の署名と公証が必要になる（確かめていない）

## 本体で採用する方針

- Python のワーカーは、PyInstaller の **onedir** の形でビルドし、Tauri の `bundle.resources` で `.app` に同梱する。Rust から `tauri-plugin-shell` の `command`（resources のパスを指定）で起動する
- ワーカーはアプリの起動中ずっと動かしておき、標準入力と標準出力で1行1件の JSON をやりとりする。要求には id を付け、結果と対応させる
- 利用者が uv や Python を別途インストールする必要はない。uv は開発とビルドのときだけ使う
- 起動時に Python の実行環境をダウンロードする方式（同梱した uv で `uv run` する）は使わない。外部への通信を増やさないため（NFR-08）

## 動かし方

```bash
npm install
npm run icon
npm run sidecar          # onefile（サイドカー）
npm run sidecar-onedir   # onedir（resources）
npx tauri build
uv run --project ml python -c "from PIL import Image; Image.new('RGB',(640,480),(200,100,50)).save('/tmp/test.png')"
SPIKE_MODE=onedir SPIKE_IMAGE=/tmp/test.png src-tauri/target/release/bundle/macos/kura-spike-python.app/Contents/MacOS/kura-spike-python
```
