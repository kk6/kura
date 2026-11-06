# ライブラリを作る・開く・切り替える

利用者は空のフォルダを Kura のライブラリにでき（`.kura/` と `_未分類/` ができる）、作ったライブラリを開き直したり、別のライブラリへ切り替えたりできる。起動時は、最近使ったライブラリの先頭を自動で開く。

## Sub-features

- `library-create`：空のフォルダを選ぶと、`.kura/kura.db` と `_未分類/` ができ、空の一覧が出る
- `library-create-nonempty`：中身のあるフォルダを選ぶと「空のフォルダを選んでください」のエラーが出て、何も作らない
- `library-autoopen`：起動時に、最近使ったライブラリの先頭を開く
- `library-switch`：メニューから選択画面に戻り、最近使ったライブラリから開き直せる

## How to get to it (user POV)

- 選択画面の「新しいライブラリを作る」「ライブラリを開く」
- 選択画面の「最近使ったライブラリ」の項目
- メニューの「ファイル」→「ライブラリを切り替える…」（⌘⇧O）
- アプリの起動（自動で開く）

## Driving it with computer-use

Preconditions:

- `library-create` は `$V launch <id> empty`。選択画面に「まだありません」が出ている。
- `library-autoopen` と `library-switch` は `$V launch <id>`（見本）。

- **作る。** 「新しいライブラリを作る」を押す。`computer_batch`：その座標を `left_click` → `wait 1.5` → `key cmd+shift+g` → `type <リポジトリ>/.claude/tmp/verify-kura/runs/<id>/lib` → `key Return` → 「開く」を `left_click`。ツールバーに「画像を取り込む」、一覧に「画像がありません。…」、ステータスバーに「完了・Finder での変更はありません」が出る。
- **作った物を確かめる。** `ls -a runs/<id>/lib` に `.kura` と `_未分類`。`$V db <id> "select count(*) from images"` が 0。`runs/<id>/home/Library/Application Support/dev.kk6.kura/recent-libraries.json` の先頭が `runs/<id>/lib`。
- **自動で開く。** 見本で起動しただけで一覧が出る。`app.log` に `ライブラリを開きました：…/runs/<id>/lib`。
- **切り替える。** `app_menu` の `path: ["ファイル", "ライブラリを切り替える…"]`。選択画面に戻り、「最近使ったライブラリ」に `lib` と run のパスが出る。それを押すと一覧に戻る。
- **中身のあるフォルダ。** `empty` で起動し、`$V src <id> 5` の `runs/<id>/src` を「新しいライブラリを作る」で選ぶ。選択画面に「空のフォルダを選んでください」のエラーが出る。`ls -a runs/<id>/src` に `.kura` と `_未分類` がない。

## Gotchas

- 選択画面の「最近使ったライブラリ」に、run の外のパスが出たら隔離が壊れている。押さずに `$V stop` し、`$V real-data-mtime` を作業前と比べる。
- ダイアログで選んだフォルダが iCloud Drive や外付けのファイルシステムだと、注意の確認（「続ける」）が出る。run のフォルダでは出ない。
- `empty` で起動した直後は約2秒、何も描かれない。screenshot で選択画面を確かめてから押す。
