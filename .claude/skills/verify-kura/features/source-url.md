# 元URL

利用者がブラウザでダウンロードした画像には、macOS がダウンロード元の記録（拡張属性 `com.apple.metadata:kMDItemWhereFroms`）を付ける。Kura は取り込みと差分の確認でこの記録を読み、1番目を画像URL、2番目を掲載ページURLとして保存する。詳細パネルの元URLを押すと既定のブラウザで開く。前の版で取り込んだ画像は、設定の「元URLを補完」で読み直せる。

## Sub-features

- `source-import`：通常の取り込みで元URLを保存する。不正な記録でも画像は取り込み、ステータスバーの「元URLの注意 N件」で対象が分かる（FR-208、FR-201〜FR-205）
- `source-finder`：Finder でライブラリに置いた画像を、差分の確認で登録するときに読む（FR-104）
- `source-duplicate`：重複でスキップした画像は、すでにある画像の元URLを変えない
- `source-link`：詳細パネルで掲載ページURLを優先して出し、押すと既定のブラウザで開く。HTTP/S 以外は開かない（NFR-09）
- `source-backfill`：設定の「元URLを補完」、進み具合、「中断」、結果の件数（FR-208、FR-105）

## How to get to it (user POV)

- ツールバーの「フォルダを取り込む」「画像を取り込む」、サイドバーの「差分を確認」
- ステータスバーの「元URLの注意 N件」
- 詳細パネルの「元URL」の欄
- 設定（⌘,）の「元URLを補完」と「中断」

## Driving it with computer-use

Preconditions:

- 記録を付けたダミー画像を作る。`uv run scripts/gen_source_urls.py .claude/tmp/verify-kura/runs/<id>/src`。`import/`、`import-dup/`、`finder/`、`backfill/` ができる。各ケースの中身はスクリプトの説明にある。URL はすべて `http://127.0.0.1:8765` の下。
- リンクの確認では、`python3 -m http.server 8765 --bind 127.0.0.1 --directory <空のフォルダ>` を `.claude/tmp/` の下で動かすと、ブラウザが読みに来たことをサーバーのログで確かめられる（404 で構わない）。

- **通常の取り込み。** 見本で起動し、「フォルダを取り込む」で `runs/<id>/src/import` を選ぶ。11枚を取り込み、ステータスバーに「元URLの注意 5件」（xml 以外の不正・部分的な記録と garbage）。`$V db <id> "select i.file_name, s.image_url, s.page_url from images i left join image_sources s on s.image_id = i.id where i.file_name like '%.png' order by 1"`。`two`、`three`、`xml` は両方、`one`、`empty-second`、`image-only` は画像URLだけ、`page-only` は掲載ページURLだけ、ほかは NULL。`three` に3件目は入らない。
- **重複。** 続けて `runs/<id>/src/import-dup` を取り込む。スキップ1件で、`import/two.png` の元URLは変わらない。
- **Finder から。** `mkdir runs/<id>/lib/srcurl && cp runs/<id>/src/finder/*.png runs/<id>/lib/srcurl/`（`cp` は拡張属性も写す。見本には `_未分類/` がない）→「差分を確認」。`srcurl` カテゴリができ、登録された画像に元URLが入り、注意の件数が増える。クリックなしで確かめるなら、`.claude/tmp/verify-kura/libs/` に見本を複製して同じように画像を置き、`$V launch <id> <そのライブラリ>` で起動する。起動時の差分の反映で読む（2026-11-13、run `m-src-1`。`import/` の11枚で「登録 11」「元URLの注意 5件」、DB の値は上の通常の取り込みと同じ）。
- **リンク。** `two` を選ぶと詳細パネルの元URLに掲載ページURL、`one` には画像URL、`none` には「なし」。押すと既定のブラウザが開き、http.server のログに `GET /page/import-two`。`non-http` は「なし」で押せない。
- **補完。** 元URLを保存しない版（main のデバッグ版など）で `backfill/` を取り込んだライブラリを、新しい版で開く。設定の「元URLを補完」→ 結果「補完 N枚、記録なし N枚、読み取り失敗 N枚、対象外 N枚」。もう一度押すと補完 0枚。すでに片方だけ入っている画像は変わらない。

## Gotchas

- 取り込みは画像を `std::fs::copy` で写すので、拡張属性も一緒に写る。Finder での手動のコピーも同じ。`cat` やリダイレクトで写すと属性が落ちる。
- 30枚の見本では補完が一瞬で終わり、補完中に重なった操作の待ちや「中断」を画面で確かめられない。数千枚のライブラリが要る（`npm run dev-library` の画像に記録を付けるか、`gen_source_urls.py` を何度か別のフォルダへ流して取り込む）。できなければ未確認として報告する。
- 本物のブラウザでダウンロードした画像の記録は、ダミーと同じ形かを利用者が確かめる（`docs/tasks/phase2-check.md` の H）。開発側は外へ通信してダウンロードしない（NFR-08）。
- 既定のブラウザを開く確認は、利用者のブラウザが手前に出る。開いたページは閉じてよいが、ほかのタブには触れない。
