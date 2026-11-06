# 詳細パネルで編集する

利用者は一覧で画像を1枚選ぶと、右の詳細パネルでファイル名（拡張子より前）、評価（星5段階）、メモを変えられる。ファイル名の変更は実ファイルの名前も変える。

## Sub-features

- `detail-show`：画像を選ぶと、プレビュー、カテゴリの道筋、タグ、サイズ、メモが出る
- `detail-rename`：ファイル名をダブルクリックで編集し、Enter で確定すると実ファイル名が変わる
- `detail-rating`：`評価 1`〜`評価 5` を押すと評価が保存される
- `detail-memo`：メモを入力し、フォーカスを外すと保存される

## How to get to it (user POV)

- 一覧（「画像の一覧」）でサムネイルを1回押す → 右の「詳細」パネル
- ファイル名の見出しをダブルクリック

## Driving it with computer-use

Preconditions:

- `$V launch <id>`（見本）。対象は一覧の左上の画像。`$V db <id> "select id, file_name, category_id from images order by imported_at desc, id limit 1"` で、その時点の名前を控える（並びの既定は取り込み日の新しい順）。

- **選ぶ。** 一覧の左上のサムネイルを `left_click`。詳細パネルの見出しにファイル名、カテゴリに `src / …` が出る。
- **評価。** 詳細パネルの星の4つ目（`評価 4`）を押す。星が4つ塗られる。`$V db <id> "select rating from images where id=<id>"` が 4。
- **メモ。** 「メモ」の欄を押して `verify memo` と入力し、一覧の空いた所を押してフォーカスを外す。`$V db … "select memo …"` が `verify memo`。
- **ファイル名。** 見出しをダブルクリックし、「ファイル名（拡張子を除く）」の欄を全選択（`cmd+a`）して `renamed-by-verify` と入力、Return。見出しが `renamed-by-verify.<拡張子>` になる。`ls runs/<id>/lib/src/<カテゴリのフォルダ>` に新しい名前があり、元の名前がない。DB の `file_name` も同じ。`pending_ops` が 0。

## Gotchas

- 日本語入力がオンだと、Return は変換の確定に使われてファイル名は確定しない。英数で入力する。
- メモは入力のたびではなく、フォーカスを外したときに保存する。外す前に DB を引くと古い値が出る。
- 同じフォルダに同じ名前があると名前の変更はエラーになる。見本の名前は `ref_00000` 形式なので、それと重ならない名前にする。
