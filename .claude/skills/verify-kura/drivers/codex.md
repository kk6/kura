# Codex の画面操作

## 接続

1. 共通手順の `$V launch <id>` と `$V doctor <id>` が成功してから接続する。`cua.getApp()` は未起動のアプリを起動することがあるため、起動の代わりに使わない。
2. `mcp__cua_repl.js` の初回呼び出しは `await cua.getState();` だけを実行し、返された API の説明を読む。利用可能なツールとその説明を優先し、Claude 用の権限取得 API は呼ばない。
3. 検証用 Kura だけが動いていることを doctor と照合し、`let app = await cua.getApp("<リポジトリの絶対パス>/src-tauri/target/debug/bundle/macos/Kura.app");` で接続する。接続直前にも doctor を確認する。画面に run の外のライブラリが出たら操作せず停止する。

## 操作

- `app.getAXState()` で現在の要素を確認し、要素番号を `app.click(番号)` に渡す。番号は直近の状態から取得する。
- WKWebView の要素操作が失敗する場合は `app.getScreenshot()` の座標を使って `app.click([x, y])` する。Claude の背景操作で押せなかったという記録から、Codex でも押せないと決めつけない。
- ダブルクリックは `app.click(対象, { clickCount: 2 })`。文字入力は `app.typeText(text)`、キーは `app.pressKey(key)`。⌘ は `super`（例：`super+shift+g`、`super+a`、`super+Delete`）。
- メニューは現在の AX にある項目を操作するか、機能別手順のショートカットを使う。「ライブラリを切り替える…」は `app.pressKey("super+shift+o")`。
- 操作後は `app.getAXState()` を取得してから次を判断する。固定の待ち時間より、表示された画面とログで完了を確認する。
- Finder が必要な手順だけ `cua.getApp("com.apple.finder")` で接続する。ドラッグは対象アプリの `drag(from, to)` を使い、対応する API と直前の画面を確認する。通せない入り口は未検証として報告する。

## 画面の証跡

`app.getScreenshot()` が返す画像バイト列を、cua_repl ランタイムで利用可能なファイル保存機能で、run の `evidence/<feature>-<step>.png` に保存する。画像形式は実際の出力に合わせる。Claude の `save_to_disk` や tool-results のパスは使わない。

操作の前後で取得し、保存先のファイルが存在して画像として読めることを確認する。保存機能が利用できなければ、画面の確認と証跡ファイルの保存を区別し、保存できなかったことを報告する。

## 終了

共通手順の `$V stop <id>` で自分の検証用プロセスだけを停止する。CUA 作業の最終結果を確認した後は、次の `mcp__cua_repl.js` 呼び出しで `completion_summary` のみを送る。`release_full_control` や `app_release` は呼ばない。
