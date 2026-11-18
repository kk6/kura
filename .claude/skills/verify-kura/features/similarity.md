# 類似画像検索

利用者は設定で類似画像検索を ON にできる。ON にすると Kura はモデルをアプリのデータフォルダへダウンロードし（初回だけ。SigLIP 2 は GitHub Release の models-1 から、ポーズの2つのモデルは OpenMMLab の配布先から zip で取って `.onnx` を取り出す）、ライブラリの画像の特徴量を裏で計算して `.kura/features.db` に保存する。1枚を選んで「似た画像を探す」を押すと、一覧が似ている順に並び、帯のスライダーで「写っているもの」「明暗と線の配置」「体の姿勢」の重みを変えられる（FR-601〜FR-605、NFR-03、NFR-08、NFR-09）。

## Sub-features

- `similarity-toggle`：設定の「類似画像検索を使う」。初期値は OFF。ON にすると大きさの確認、ダウンロード、SHA-256 の照合を経て ON になる。OFF に戻してもモデルと特徴量は残る
- `similarity-download-fail`：ダウンロードに失敗すると、エラーと「再試行」が出て OFF のまま。書きかけの `.part` は残らない
- `similarity-calc`：ON の間、未計算の画像をワーカー（`.app` の `Contents/Resources/worker/kura-worker`）が1枚ずつ計算する。ステータスバーに「特徴量を計算中 N / M枚」、設定に計算済み・残り・計算できなかった枚数と「再計算」
- `similarity-search`：詳細パネルと右クリックメニューの「似た画像を探す」、結果のモード（2段の帯、「未計算 N枚」、「閉じる」と Escape）
- `similarity-weights`：帯の「写っているもの」「明暗と線の配置」「体の姿勢」のスライダー。最後の値は `settings.json` の `similarity_weights`
- `similarity-pose`：ポーズの計算（`features.db` の `poses`）と、基準の画像にポーズがないときの理由の表示。ON でポーズのモデルだけがないときは、設定に「「体の姿勢」で比べるには、ポーズのモデル（約70 MB）が必要です」と「ダウンロード」
- `similarity-filter`：結果をサイドバーのカテゴリ・タグと検索欄で絞る

## How to get to it (user POV)

- 設定（⌘,）の「類似画像検索」の節：チェック「類似画像検索を使う」、確認の「ダウンロードして使う」「キャンセル」、「再試行」、「再計算」
- 1枚を選んだときの詳細パネルの「似た画像を探す」（未計算なら押せず「特徴量を計算するまで探せません」）
- 画像の右クリックメニューの「似た画像を探す」
- 結果のモードの帯：基準のサムネイル、「似た画像」と枚数、「未計算 N枚」、「閉じる」、スライダー（グループ「観点ごとの重み」の「写っているもの」「明暗と線の配置」「体の姿勢」）。基準にポーズがなければ「体の姿勢」のスライダーの代わりに理由
- 設定の「類似画像検索」の「ダウンロード」（ON でポーズのモデルがないときだけ）

## Driving it with computer-use

ワーカーと性能を確かめるので、リリース用ビルドを使う（`KURA_BUILD=release $V build`。`npm run worker:build` も流れる）。デバッグ版は `ml/.venv` の Python でワーカーを起動するので、同梱の確認にならない。以下、`R="env KURA_BUILD=release"` とし、uv も Python もない環境と同じ条件にするため `PATH=/usr/bin:/bin:/usr/sbin:/sbin` で起動する。

### モデルを置く（ダウンロードの代わり）

```bash
PATH=/usr/bin:/bin:/usr/sbin:/sbin $R $V launch <id>
$R $V model <id>      # run のアプリのデータフォルダの models/ に置き、SHA-256 を ml/model.json と照らす
```

複製元は本体のリポジトリの `spikes/similarity/models/siglip2-b16.onnx`（git の管理外。スパイクで Hugging Face から取ったもの）。別の場所にあれば `KURA_MODEL_SRC=<ファイル>` を付ける。置いた後に設定で ON にすると、確認の後「モデルを確認中…」を経て、通信せずに ON になる。`app.log` に `モデルをダウンロードします` が出ないこと、`モデルをそろえました` が出ることを確かめる。

### ポーズのモデルを置く（OpenMMLab からのダウンロードの代わり）

`model <id>` は内容のモデルだけを置く。3a から更新した利用者と同じ、ポーズのモデルだけがない状態になる。ポーズのモデルは、アプリと同じく取得元の zip から取り出して置く。

```bash
$R $V model <id> pose   # ml/model.json の pose の files を、zip の SHA-256 → unzip -p → .onnx の SHA-256 の順に確かめて置く
```

zip は本体のリポジトリの `.claude/tmp/verify-kura/pose-zips/` に、URL の末尾の名前で置いておく（`KURA_POSE_ZIPS` で変えられる）。なければ、コマンドが取るための `curl` の1行を出して止まる。開発側の通信なので、流すのは利用者に断ってから（2026-11-18 に取った2つは `archive.sha256` と合った）。

ON にする流れ（確認の「ダウンロードして使う」）は、欠けているファイルを全部取る。`model <id>` で内容だけを置いて ON にしても、ポーズの zip を取りに行く（`net up` していなければ失敗して OFF のまま）。3a から更新した状態（ON で、ポーズのモデルだけがない）は、ON にした後に作る：

1. `model <id>` と `model <id> pose` で全部を置いてから ON にする（通信しない）。または `net up` で ON にして本物の URL から取る
2. 計算が終わったら、`models/` のポーズの2つの `.onnx` を run の中の別のフォルダへ移す。設定を開くと「「体の姿勢」で比べるには、ポーズのモデル（約70 MB）が必要です」と「ダウンロード」が出る（`missing_models` はファイルの有無だけを見る）
3. この間に足した画像は、内容と構図だけが計算される（`app.log` の `特徴量の計算の計画：対象 …、未計算 …` に足した枚数）
4. `model <id> pose` で戻し、設定の「ダウンロード」を押す。SHA-256 を確かめて通信せずに終わり（`モデルをそろえました`）、足した画像のポーズだけを計算する

2026-11-18 に確かめたこと（`runs/pose-1/evidence/`）：

- `net up` で ON にすると、`proxy.log` に `CONNECT download.openmmlab.com:443` が2回、`github.com` はなし（内容のモデルは置いてあった）。2つの zip を約7秒で取った
- ポーズのモデルを外して10枚を足すと、設定に「ダウンロード」が出た。`model <id> pose` で戻して「ダウンロード」を押すと、`proxy.log` が増えず、`poses` が164件から174件になった。`embeddings` の `hash, aspect, computed_at` は前後で同じだった（`emb-before.txt` と `emb-after.txt`）

失敗させる手順は下の節と同じで、表示も同じ。

### ポーズの確認用のライブラリ（人物なし・関節不足・左右反転）

見本の人物の写真の写しから作る。見本は読むだけにする。

```bash
B=.claude/tmp/verify-kura
rsync -a --exclude .DS_Store /Users/kk6/Projects/kura-library/人物/ $B/pose-src/人物/
cp -R $B/template $B/pose-lib && mkdir -p $B/pose-lib/人物
ls $B/pose-src/人物/*.jpg | head -40 | while read f; do cp "$f" $B/pose-lib/人物/; done
ml/.venv/bin/python -I .claude/skills/verify-kura/pose_images.py $B/pose-src/人物 $B/pose-lib 40
PATH=/usr/bin:/bin:/usr/sbin:/sbin KURA_PROXY=1 $R $V launch pose-1 $B/pose-lib
```

- 人物なし（`status` 0）：見本の `src/` のダミー画像。人物の枠が出ない
- 関節が足りない（`status` 1）：`脚/` の、写真の下の40%を切り出した画像。2割ほどが1になり、残りは0か2になる。手で切り抜いた画像は、人物の枠が出ずに0になりやすい（上の30%を切ると20枚中15枚が0、1は1枚だった）
- 左右反転：`反転/` の `flip-<名前>`。`人物/<名前>` を基準にして「体の姿勢」を重くすると上に来る
- 2人が写った画像の代わり：`組/` の `pair-<名前1>+<名前2>.jpg`（隣り合う2枚を横に並べたもの）。`人物/<名前1>` か `人物/<名前2>` を基準にすると上に来る
- 何枚が0・1・2になるかは写真で変わる。どれを基準にするかは、計算の後に下の SQL で選ぶ

### ポーズの計算が済んだかを features.db で確かめる

`poses` の表に、画像の hash ごとに1行。`status` は 0（人物なし）、1（関節が足りない）、2（ポーズあり）。`people` は2のときだけ空でない（1人51個の float32）。

```bash
$V db <id> "select status, count(*) from poses group by status" features
$V db <id> "select aspect, count(*) from embeddings group by aspect" features   # ポーズの後も件数と computed_at が変わらない
$V db <id> "select count(*) from images where deleted_at is null and missing_at is null"
```

- 終わったかは、`poses` の件数と `images` の件数がそろったかで見る（ゴミ箱と「見つからない」は数えない）
- `status` ごとの画像の名前は、`kura.db` の `images.hash` と結ぶ。2つの DB は別のファイルなので、`$V db` を2回引いて hash で照らす：
  `$V db <id> "select hash, status from poses" features` と `$V db <id> "select i.hash, coalesce(c.name, '-'), i.file_name from images i left join categories c on c.id = i.category_id"`
- 2026-11-18 の `pose-lib`（164枚）では、0 が41枚（ダミー30枚中のすべてと、人物2枚、反転1枚、脚8枚）、1 が9枚（脚7枚、人物1枚、反転1枚）、2 が114枚。`組/` は20枚すべて2
- 内容と構図を計算し直していないことは、ポーズのモデルを置く前と後の `select hash, aspect, computed_at from embeddings` を比べる（同じなら計算し直していない）
- `app.log` の `特徴量の計算の計画：対象 …、未計算 …` の未計算が、ポーズのモデルを置いた後に画像の枚数になり、計算の後に0になる

### ダウンロードを失敗させる・元に戻す

検証用の Kura の curl を、run ごとのプロキシ（`proxy.py`、HTTPS の CONNECT だけを中継する）に通す。利用者の Mac のネットワークは切らない。

```bash
PATH=/usr/bin:/bin:/usr/sbin:/sbin KURA_PROXY=1 $R $V launch <id>   # アプリに HTTPS_PROXY=http://127.0.0.1:18080 を渡す
$R $V net <id> up       # 通信の口を開ける。つないだ先は evidence/proxy.log に1行ずつ残る
$R $V net <id> down     # 閉じる。ダウンロードの途中なら、その通信も切れる
```

- **つながっていない。** `net up` の前に ON にして「ダウンロードして使う」を押す。「エラー：モデルをダウンロードできません（curl: (7) Failed to connect to 127.0.0.1 port 18080 …）」と「再試行」が出て、チェックは外れたまま。`models/` に `.part` も本体もない。`settings.json` の `similarity_enabled` は false（ファイルがなければそれでよい）。
- **途中で切れる。** `net up` してから「ダウンロードして使う」を押し、設定に「モデルをダウンロード中 N MB / 355 MB」が出ている間に `net down`。エラーと「再試行」が出て、`.part` が消えている。`proxy.log` に `CONNECT github.com:443` と、切れた行が残る。
- **元に戻す。** `net up` してから「再試行」。ダウンロードが最後まで進み、チェックが入る。`app.log` に `モデルをダウンロードします：<URL>` が1回、`models/` に本体だけがあり SHA-256 が合う。
- **通信しないこと（NFR-08）。** 起動しただけ、設定を開いただけ、確認で「キャンセル」したときは、`net up` していても `proxy.log` に `CONNECT` の行が増えない。`lsof -nP -a -i -p $(cut -f1 runs/<id>/pid)` と `pgrep -fl curl` も空。
- models-1 にファイルを置く前は、`net up` でも `curl: (56) … 404` で失敗する。これは「元に戻す」の確認にならない。置いた後に確かめる。置く前に「元に戻す」の経路だけを見るなら、失敗した後に `$R $V model <id>` で置いて「再試行」する（通信せずに ON になる）。

### 2万枚のライブラリ（性能の確認用）

見本を写し、人物の写真から作った約1万枚と、ダミー画像を約9,400枚置いて、Kura に差分の確認で登録させる。人物の画像を混ぜるのは、ポーズのある画像どうしの比べ方（3b）の時間を測るため（ダミーだけだとポーズはすべて「人物なし」になり、比べる組がない）。特徴量は実アプリで計算する。一度作ったら、性能の確認のたびに写して使う。

```bash
B=.claude/tmp/verify-kura
rsync -a --exclude .DS_Store /Users/kk6/Projects/kura-library/人物/ $B/pose-src/人物/   # 「ポーズの確認用のライブラリ」と同じ写し
cp -R $B/template $B/lib20k && mkdir -p $B/lib20k/人物 && cp $B/pose-src/人物/*.jpg $B/lib20k/人物/
ml/.venv/bin/python -I .claude/skills/verify-kura/pose_images.py $B/pose-src/人物 $B/lib20k 169 59   # 脚・反転・組と、変形 9,971枚。約1分20秒
uv run scripts/gen_dev_library.py 9400 --out $B/lib20k/dummy   # 約20秒
PATH=/usr/bin:/bin:/usr/sbin:/sbin KURA_PROXY=1 KURA_IN_PLACE=1 $R $V launch build20k $B/lib20k
```

1. `app.log` に `差分を反映しました：登録 …` が出るまで待つ（ダミーの重複と非対応形式はスキップに数えられる）。2026-11-18 は2分23秒で、登録 19,923、合わせて19,953枚。
2. `$R $V model build20k` と `$R $V model build20k pose` でモデルを置き、設定で ON にする（通信しない）。ステータスバーに「特徴量を計算中 N / M枚」。`pgrep -fl kura-worker` が `.app` の中のワーカーを指す。
3. 計算が終わるまで待つ。`images`（ゴミ箱と「見つからない」を除く）、`embeddings` の `content`、`poses` の件数がそろえば終わり。2026-11-18 は26分22秒（内容・構図・ポーズの3つ、Apple M5 Max、1スレッド）。ポーズは2（ポーズあり）が10,174枚、1が322枚、0が9,457枚。
4. `$R $V stop build20k`。`KURA_IN_PLACE` なので `lib20k` はそのまま残る（stop は run の `lib` のリンクだけを消す）。

使うときは `$R $V launch <id> $B/lib20k` で写して開く（2万のサムネイルも写す）。計算中の確認には、写した後に `.kura/features.db` を消してから開く（`cp -R $B/lib20k $B/lib20k-nofeat && rm $B/lib20k-nofeat/.kura/features.db*`）。

### 見分けやすい写真のライブラリ

見本の写真（`/Users/kk6/Projects/kura-library`）は読むだけにし、ライブラリとして開かない（それ自体が Kura のライブラリで、`.kura/` を持つ）。`.kura/` を除いて写し、空の `.kura/` を置いて開く。Kura が `kura.db` を作り、差分の確認で写真を登録する（88枚、カテゴリ7件）。

```bash
rsync -a --exclude .kura --exclude _未分類 --exclude .DS_Store /Users/kk6/Projects/kura-library/ $B/photos-src/
mkdir -p $B/photos-lib/.kura $B/photos-lib/_未分類 && cp -R $B/photos-src/* $B/photos-lib/
PATH=/usr/bin:/bin:/usr/sbin:/sbin KURA_IN_PLACE=1 $R $V launch photos $B/photos-lib
$R $V model photos     # 設定で ON にすると数秒で計算が終わる
```

`$R $V stop photos` の後も `photos-lib` は残る。カテゴリ（`動物/猫` など）が同じ被写体の組になる。似た構図で内容の違う組は、特徴量から候補を出せる（読むだけ）：`features.db` と `kura.db` を WAL ごと別の場所へ写し、構図のベクトルの内積の1位が別の最上位のカテゴリになる組を挙げる。2026-11-16 の写しでは、内容の上位3件の97%が同じカテゴリだった。構図で互いに1位になる組に、風景と犬、人物と小物、ラッコと風景があった（`runs/photos-1/evidence/pairs.txt`）。並びが納得できるかは利用者が画面で決める。

### 確かめること（phase3-check との対応）

- **A（ON/OFF とモデル）。** 上の3つの節。OFF の間は `pgrep -fl kura-worker` が空、詳細パネルにも右クリックメニューにも「似た画像を探す」がない。OFF → ON の2回目は確認の後に通信せず ON（`proxy.log` が増えない）。ON の後に `net down` のまま「再計算」と検索ができる（NFR-09）。
- **B（計算）。** `lib20k-nofeat` で ON にし、計算中にスクロール、タグ付け、絞り込み、取り込み（`$V src`）、↻、カテゴリの移動、ゴミ箱、ボードの編集をする。どれもステータスバーの計算の表示が続いたまま終わる。⌘Q で待たずに終わり、`pgrep -fl 'Kura.app|kura-worker'` が空。`relaunch` で開き直すと `app.log` の `特徴量の計算の計画：対象 …、未計算 …` の未計算が減っている。
- **C・E（探す、絞り込む）。** 写真のライブラリで、カテゴリの同じ写真が上のほうに来るか。結果の中のタグ付け、メモ、ゴミ箱、結果の画像からもう一度探す。
- **D（重み）。** スライダーを動かして並びが変わる。手を離すと `runs/<id>/home/Library/Application Support/dev.kk6.kura/settings.json` の `similarity_weights` が変わる。起動のときに `KURA_ALSO=<2つ目のライブラリ>` を付けておき、⌘⇧O で切り替えてから探すと、同じ値で始まる。⌘Q で終わらせてから `PATH=/usr/bin:/bin:/usr/sbin:/sbin $R $V relaunch <id>` で同じ HOME のまま起動し直し、探すと同じ値で始まる。
- **F（既存の操作との連動）。** 名前の変更・カテゴリの変更・ゴミ箱と戻すの前後で `$V db <id> "select count(*) from embeddings" features` が変わらない。完全に削除と「一覧から外す」の後に、その画像のハッシュの行が消える（`select count(*) from embeddings where hash = '<sha256>'`）。`features.db` を消して開くとエラーにならず計算し直す。
- **G（性能）。** `similar_images` の時間は `app.log` の `類似度を計算しました（N枚、未計算 N枚、…ms）`。押してから描き終わるまでは画面で見る。再起動直後（OS のキャッシュが冷えた状態）の1回目は、Mac を再起動してから最初の検索で測る（`sudo purge` は利用者が自分で流す）。計算の時間は、ON にした時刻と最後の `features` の件数がそろった時刻の差、または `特徴量の計算の計画` の行の間隔から出す。
- **H（ポーズ）。** 上の「ポーズの確認用のライブラリ」で行う。
  - H-1（3a からの更新）：「ポーズのモデルを置く」の手順の2。設定に「ダウンロード」、結果の帯に「体の姿勢」の代わりに「ポーズのモデルを設定から取得してください」の理由が出て（`src/similarity.ts` の文。2026-11-18 は帯の表示を実アプリで見ていない）、`proxy.log` が増えない。本物の 0.5.0 から更新する確認は、利用者がリリース用ビルドで行う
  - H-2（ポーズだけを足す）：同じ手順の3と4。`embeddings` の `computed_at` が前と同じで、`poses` の件数が画像の枚数になる
  - H-3〜H-5、H-7：`人物/`、`反転/`、`組/`、`脚/` と `src/` を混ぜたまま、`人物/` の1枚を基準に「写っているもの」「明暗と線の配置」を左端、「体の姿勢」を右端へ。上位に同じ人の `flip-` と `pair-` が来て、`脚/` と `src/` の画像が結果に残り、末尾に固まらない（結果の最後までスクロールして見る）。2026-11-18 は `人物/ahmed-nishaath-wBXibuuhxdk` を基準にし、`pair-` が2位、`flip-` が3位、末尾は姿勢の違う人物だった（`pose-04-pose-only.jpg`、`pose-05-pose-only-tail.jpg`）。基準は検索欄でファイル名を引いて右クリックの「似た画像を探す」で選び、検索欄を空にしてから並びを見る（検索欄は結果も絞る）
  - H-6：`src/` のダミー画像（`status` 0）を基準にする。「体の姿勢」の代わりに「基準の画像に人物がいません」が出る（`pose-06-none-reason.jpg`）
  - H-8：2万枚のライブラリ（上の節）で、ポーズのある画像を基準に探し、`類似度を計算しました（…ms）` を見る。2026-11-18 は106〜119ms（3回）、`relaunch` の直後の1回目が104ms（`runs/build20k/evidence/`）。基準にポーズがないと、ポーズの比べ方を飛ばすので速くなる。測るときは人物の画像を基準にする
- 「体の姿勢」を右端、ほかを左端（0）に保存した後に、人物のいない画像を基準にすると、残りの2本は真ん中に出る（`fillWeights` が、使える観点が全部0なら初期値で埋める）。`settings.json` の値は0のまま
- この環境では、背景操作（`app_click`）が WKWebView に届かず断られた（2026-11-18）。全画面操作に移った。Stage Manager でウィンドウの位置が操作のたびに変わるので、毎回撮り直してから押す
