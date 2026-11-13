# Claude Code の画面操作

computer-use を使う。準備：
- `request_access` に `dev.kk6.kura`（取り込み元を Finder で見せるときは Finder も）。
- **WKWebView の中のボタンは、背景操作（`app_click`）では押せない**（「canvas/custom view」と断られる）。画面の中を押すには `request_full_control` で全画面操作の承認をもらい、`computer_batch` を使う。承認を求める前に、どの手順のためかを利用者に1行で伝える。
- 背景操作でできること：`app_screenshot`（AX の要約にボタン名が出る。位置確認に使う）、`app_menu`（メニューバー）。メニューは `app_menu` を優先する：
  - `["ファイル", "ライブラリを切り替える…"]`（⌘⇧O）

座標は毎回 `computer_batch` の `screenshot` から読む。ウインドウの位置は起動ごとに変わる。押す相手は画面の文字（ボタン名、aria-label）で探す。
## 画面の証跡

画面：`computer_batch` に `save_to_disk: true` をつけて `screenshot` する。結果に出る `source:` のパス（`~/.claude/projects/…/tool-results/…jpg`）を `evidence/<feature>-<step>.jpg` に `cp` する。操作の前と後の両方を撮る。

## 終了

共通手順の `$V stop <id>` の後、全画面操作を使ったら `release_full_control`、最後に `app_release` を呼ぶ。
