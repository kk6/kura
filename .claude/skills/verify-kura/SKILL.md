---
name: verify-kura
description: Kura（Tauri 2 の macOS デスクトップアプリ）の実アプリを、利用者のデータから隔離して起動し、computer-use で操作して、画面・ファイル・DB の証跡で動作を確かめる手順。Rust のコマンド、ファイル操作、DB、取り込みなど、モックの画面（npm run dev:mock）では確かめられない変更を「実アプリで動くか」確かめるときに使う。
---

# Kura の実アプリでの検証

Kura は Tauri 2 のデスクトップアプリ。画面は WKWebView の React、処理は Rust。モックの画面（`npm run dev:mock` と `npm run test:e2e`）は Rust を通らないので、ファイル・DB・取り込みに関わる変更はこの手順で実アプリを動かして確かめる。画面だけの変更なら、CLAUDE.md の Playwright のモックで足りる。

ヘルパー：`.claude/skills/verify-kura/kura-verify.sh`（リポジトリのルートから実行する。以下 `$V`）

```bash
V=.claude/skills/verify-kura/kura-verify.sh
```

## 絶対に守ること

- 本物の資料フォルダに触れない。読み取りもしない。`launch` に渡すライブラリは、この手順で作ったものだけにする。
- アプリは起動時に「最近使ったライブラリ」の先頭を自動で開く。利用者の `~/Library/Application Support/dev.kk6.kura/` には本物のライブラリの場所が入っている。だから `Kura.app` を `open` や Finder で起動しない。必ず `$V launch` で起動する。`launch` は HOME を run のフォルダに差し替えるので、アプリのデータ（recent-libraries.json、settings.json）は run の中に置かれる。
- 同時に動かす検証用の Kura は1つだけ。`launch` は、別の検証用 Kura が動いていれば止まる。利用者が自分で開いた Kura は操作しない。

## Launch

1. ビルド（ソースを変えたら毎回）。デバッグ版の `.app` を作る。画面は中に埋め込まれるので、開発サーバーもポートも要らない。約30秒。
   ```bash
   $V build
   ```
   出力：`src-tauri/target/debug/bundle/macos/Kura.app`（バンドル ID `dev.kk6.kura`）
2. 起動。`<id>` は run ごとに新しい名前にする（例：`trash-1`）。
   ```bash
   $V launch <id>            # 見本のライブラリ（30枚、カテゴリつき）を複製して開く。既定
   $V launch <id> empty      # ライブラリなし。選択画面から始まる（作る・開くの検証）
   ```
   run のフォルダは `.claude/tmp/verify-kura/runs/<id>/`（git の対象外）。中身は `home/`（偽の HOME）、`lib/`（ライブラリ）、`app.log`、`pid`、`evidence/`。
3. 準備完了の印：`launch` が最後に `doctor` を流し、全部 `ok` になること。見本から起動した場合は `app.log` に `ライブラリを開きました：…/runs/<id>/lib` と `差分を反映しました：登録 0、移動 0、…` が出る。`empty` では選択画面が出るまで約2秒待つ。

### 見本を作る（`.claude/tmp/verify-kura/template/` がないとき、または DB の形を大きく変えたとき）

見本は実アプリの「新しいライブラリを作る」と「フォルダを取り込む」で作る（features/library.md と features/import.md の手順そのもの）。

```bash
$V launch seed empty
$V src seed 30            # runs/seed/src/ にダミー画像 30枚（重複・非対応形式・隠しファイルつき）
```
画面で `runs/seed/lib` をライブラリとして作り、`runs/seed/src` をフォルダごと取り込む。`app.log` に `取り込みました：30枚、スキップ 5件` が出たら：
```bash
$V template seed          # アプリを止めて lib/ を template/ に保存
$V stop seed
```
古い見本は、起動時の移行（MIGRATIONS）で新しい DB の形に上がる。それで足りないときだけ作り直す。

## Doctor

おかしいと思ったら最初に流す。読み取りだけ。
```bash
$V doctor <id>
```
- `process … alive`：自分が起動した pid が生きている
- `HOME=…/runs/<id>/home`：隔離されている。これが `FAIL` なら即 `stop` して、利用者のデータを汚していないか `$V real-data-mtime` で確かめる
- `one verification Kura running`
- `build is newer than src/ …`：`warn` なら `$V build` してから起動し直す
- recent-libraries.json と app.log の末尾

## Drive

computer-use を使う。準備：
- `request_access` に `dev.kk6.kura`（取り込み元を Finder で見せるときは Finder も）。
- **WKWebView の中のボタンは、背景操作（`app_click`）では押せない**（「canvas/custom view」と断られる）。画面の中を押すには `request_full_control` で全画面操作の承認をもらい、`computer_batch` を使う。承認を求める前に、どの手順のためかを利用者に1行で伝える。
- 背景操作でできること：`app_screenshot`（AX の要約にボタン名が出る。位置確認に使う）、`app_menu`（メニューバー）。メニューは `app_menu` を優先する：
  - `["ファイル", "ライブラリを切り替える…"]`（⌘⇧O）

座標は毎回 `computer_batch` の `screenshot` から読む。ウインドウの位置は起動ごとに変わる。押す相手は画面の文字（ボタン名、aria-label）で探す。主な目印：

| 場所 | 目印 |
| --- | --- |
| 選択画面 | ボタン「新しいライブラリを作る」「ライブラリを開く」、見出し「最近使ったライブラリ」 |
| ツールバー | 検索欄（aria-label「検索」、⌘F）、「画像を取り込む」「フォルダを取り込む」、並べ替え、サムネイルの大きさ、設定（⌘,） |
| サイドバー（aria-label「サイドバー」） | 「すべての画像」「未分類」「ゴミ箱」と件数、カテゴリの木、「差分を確認」、タグ |
| 一覧 | aria-label「画像の一覧」。ダブルクリックで拡大表示 |
| 詳細パネル（aria-label「詳細」） | ファイル名（ダブルクリックで変更）、`評価 1`〜`評価 5`、メモ、「ゴミ箱へ移す」 |
| ステータスバー | 「完了：取り込み N枚」「注意：スキップ N件」など |

フォルダ選択のダイアログ（NSOpenPanel）は、⌘⇧G → 絶対パスを入力 → Return → 右下の「開く」（または「選択」）で選ぶ。`.claude` は隠しフォルダだが、⌘⇧G なら入れる。

## Evidence

置き場所：`.claude/tmp/verify-kura/runs/<id>/evidence/`。`stop` してもここは消えない。

- 画面：`computer_batch` に `save_to_disk: true` をつけて `screenshot` する。結果に出る `source:` のパス（`~/.claude/projects/…/tool-results/…jpg`）を `evidence/<feature>-<step>.jpg` に `cp` する。操作の前と後の両方を撮る。
- DB：`$V db <id> "<SQL>"`（読み取り専用で開く）。例：`select id, file_name, category_id, rating, memo, deleted_at from images`。結果を `evidence/<feature>-db.txt` に保存する。
- ファイル：`ls -R .claude/tmp/verify-kura/runs/<id>/lib` で実ファイルの位置と名前を確かめる（カテゴリはフォルダ、ゴミ箱は `lib/.kura/trash/`）。
- ログ：`app.log`（`stop` で `evidence/app.log` に写る）。

証拠の基準：
- 利用者と同じ操作で動かす。`$V db` は確認だけに使い、DB やファイルを手で書き換えて状態を作らない。
- 操作と結果の状態の両方を残す。最後の画面だけでは足りない。
- 画面に出たことに加えて、副作用（ファイルの移動・名前、DB の行、`pending_ops` が空であること）を確かめる。
- 利用者のアプリデータに触れていないことを、作業の前後の `$V real-data-mtime` の比較で確かめる。

## Cleanup

```bash
$V stop <id>
```
自分が起動した pid だけを止め（名前で kill しない）、`home/`、`lib/`、`src/`、`app.log` を消す。`evidence/` は残す。全画面操作を使ったら `release_full_control`、最後に `app_release` を呼ぶ。失敗した試行のあとも必ず `stop` する。run のフォルダごと消すのは、証跡が要らなくなってから利用者が決める。

## Helpers

`kura-verify.sh` のサブコマンド：

| コマンド | 内容 |
| --- | --- |
| `build` | `npm run tauri build -- --debug --bundles app` |
| `launch <id> [empty\|template\|<lib>]` | 隔離して起動し、doctor を流す |
| `doctor <id>` | 上の確認 |
| `src <id> [枚数]` | 取り込み元のダミー画像を `runs/<id>/src/` に作る（`scripts/gen_dev_library.py`） |
| `db <id> "<SQL>"` | run のライブラリの DB を読み取り専用で引く |
| `template <id>` | アプリを止め、run の `lib/` を見本として保存する |
| `stop <id>` | 停止と後片付け。証跡は残す |
| `real-data-mtime` | 利用者のアプリデータのファイルの更新日時（中身は読まない） |

機能ごとの手順は `features/README.md` から引く。
