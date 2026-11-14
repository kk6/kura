# Claude Code の画面操作

computer-use を使う。準備：
- **利用者の Kura（`/Applications/Kura.app`）が動いていないことを先に確かめる**（`pgrep -fl Kura.app` に出るのが `src-tauri/target/…/Kura.app` だけ）。検証用のデバッグ版と同じバンドル ID `dev.kk6.kura` なので、computer-use の操作や `open_application` が本物のライブラリを開いた Kura に当たるおそれがある。動いていたら操作を始めず、利用者に終了を頼む。
- `request_access` に `dev.kk6.kura`（取り込み元を Finder で見せるときは Finder も）。
- 背景操作（`app_*`）でできること（2026-11-14 に確認）：
  - `app_screenshot`（AX の要約にボタン名と `[N]` が出る）と `app_ax_find`（名前で探す）
  - WKWebView の中のクリック（`app_click` の座標か `element_index`。raw input で届く）、`app_scroll`、`app_type` の文字の入力
  - ボードのウィンドウは `app_list_windows` で出る `window_id` を渡して操作する
  - `app_menu`（メニューバー）。例：`["ファイル", "ライブラリを切り替える…"]`（⌘⇧O）
- 背景操作でできないこと：`app_key` の Return は WKWebView に届かなかった（タグの確定が通らない）。キーを使う手順（Return、Escape、⌘⇧B、⌘Delete、⌘A、名前の変更の確定）とフォルダ選択のダイアログ（NSOpenPanel の ⌘⇧G）は、`request_full_control` で全画面操作の承認をもらい、`computer_batch` で通した。承認を求める前に、どの手順のためかを利用者に1行で伝える。
- 背景操作でウィンドウをつかんでいる間は `computer_batch` が断られる。全画面操作に移る前に `app_release` を呼ぶ。

座標は毎回直前のスクリーンショットから読む。ウインドウの位置は起動ごとに変わり、別のディスプレイに出ることもある。`computer_batch` の screenshot に Kura が写らなければ、結果に出るディスプレイ名を `switch_display` に渡して撮り直す。押す相手は画面の文字（ボタン名、aria-label）で探す。

## 画面の証跡

画面：`computer_batch` に `save_to_disk: true` をつけて `screenshot` する。結果に出る `source:` のパス（`~/.claude/projects/…/tool-results/…jpg`）を `evidence/<feature>-<step>.jpg` に `cp` する。`app_screenshot` も同じ `source:` を出すので、同じように写せる。操作の前と後の両方を撮る。

## 終了

共通手順の `$V stop <id>` の後、全画面操作を使ったら `release_full_control`、最後に `app_release` を呼ぶ。
