# 類似画像検索

利用者は設定で類似画像検索を ON にできる。ON にすると Kura はモデルを GitHub Release からアプリのデータフォルダへダウンロードし（初回だけ）、ライブラリの画像の特徴量を裏で計算して `.kura/features.db` に保存する。1枚を選んで「似た画像を探す」を押すと、一覧が似ている順に並び、帯のスライダーで「内容」と「構図」の重みを変えられる（FR-601〜FR-604、NFR-03、NFR-08、NFR-09）。

## Sub-features

- `similarity-toggle`：設定の「類似画像検索を使う」。初期値は OFF。ON にすると大きさの確認、ダウンロード、SHA-256 の照合を経て ON になる。OFF に戻してもモデルと特徴量は残る
- `similarity-download-fail`：ダウンロードに失敗すると、エラーと「再試行」が出て OFF のまま。書きかけの `.part` は残らない
- `similarity-calc`：ON の間、未計算の画像をワーカー（`.app` の `Contents/Resources/worker/kura-worker`）が1枚ずつ計算する。ステータスバーに「特徴量を計算中 N / M枚」、設定に計算済み・残り・計算できなかった枚数と「再計算」
- `similarity-search`：詳細パネルと右クリックメニューの「似た画像を探す」、結果のモード（2段の帯、「未計算 N枚」、「閉じる」と Escape）
- `similarity-weights`：帯の「内容」「構図」のスライダー。最後の値は `settings.json` の `similarity_weights`
- `similarity-filter`：結果をサイドバーのカテゴリ・タグと検索欄で絞る

## How to get to it (user POV)

- 設定（⌘,）の「類似画像検索」の節：チェック「類似画像検索を使う」、確認の「ダウンロードして使う」「キャンセル」、「再試行」、「再計算」
- 1枚を選んだときの詳細パネルの「似た画像を探す」（未計算なら押せず「特徴量を計算するまで探せません」）
- 画像の右クリックメニューの「似た画像を探す」
- 結果のモードの帯：基準のサムネイル、「似た画像」と枚数、「未計算 N枚」、「閉じる」、スライダー（グループ「観点ごとの重み」の「内容」「構図」）

## Driving it with computer-use

ワーカーと性能を確かめるので、リリース用ビルドを使う（`KURA_BUILD=release $V build`。`npm run worker:build` も流れる）。デバッグ版は `ml/.venv` の Python でワーカーを起動するので、同梱の確認にならない。以下、`R="env KURA_BUILD=release"` とし、uv も Python もない環境と同じ条件にするため `PATH=/usr/bin:/bin:/usr/sbin:/sbin` で起動する。

### モデルを置く（ダウンロードの代わり）

```bash
PATH=/usr/bin:/bin:/usr/sbin:/sbin $R $V launch <id>
$R $V model <id>      # run のアプリのデータフォルダの models/ に置き、SHA-256 を ml/model.json と照らす
```

複製元は本体のリポジトリの `spikes/similarity/models/siglip2-b16.onnx`（git の管理外。スパイクで Hugging Face から取ったもの）。別の場所にあれば `KURA_MODEL_SRC=<ファイル>` を付ける。置いた後に設定で ON にすると、確認の後「モデルを確認中…」を経て、通信せずに ON になる。`app.log` に `モデルをダウンロードします` が出ないこと、`モデルをそろえました` が出ることを確かめる。

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

見本を写し、ダミー画像を2万枚置いて、Kura に差分の確認で登録させる。特徴量は実アプリで計算する（Apple M5 Max のリリース用ビルドで、登録に約2分、計算に16分38秒。2026-11-16）。一度作ったら、性能の確認のたびに写して使う。

```bash
B=.claude/tmp/verify-kura
cp -R $B/template $B/lib20k
uv run scripts/gen_dev_library.py 20000 --out $B/lib20k/dummy20k   # 約1分
PATH=/usr/bin:/bin:/usr/sbin:/sbin KURA_IN_PLACE=1 $R $V launch build20k $B/lib20k
```

1. `app.log` に `差分を反映しました：登録 …` が出るまで待つ（ダミーの重複と非対応形式はスキップに数えられる）。
2. `$R $V model build20k` でモデルを置き、設定で ON にする。ステータスバーに「特徴量を計算中 N / M枚」。`pgrep -fl kura-worker` が `.app` の中のワーカーを指す。
3. 計算が終わるまで待つ。`$R $V db build20k "select count(*) from images where deleted_at is null and missing_at is null"` と、`$R $V db build20k "select aspect, count(*) from embeddings group by aspect" features` の件数がそろえば終わり。
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

### 証跡

- 画面：設定の「類似画像検索」の節、確認、エラーと「再試行」、ステータスバーの計算中、結果のモードの帯、スライダーを動かす前と後
- プロセス：`pgrep -fl kura-worker`、`ps -o pid,%cpu,rss,command -p <ワーカーの pid>`
- 通信：`evidence/proxy.log`、`lsof` の結果
- DB：`$V db <id> "<SQL>" features`、`ls -l runs/<id>/lib/.kura/`
- 設定：`settings.json` の `similarity_enabled` と `similarity_weights`
- ログ：`app.log` の `モデルを…`、`特徴量の計算の計画…`、`類似度を計算しました…`

## Gotchas

- `model` は `launch` の後に流す（`home/` が要る）。アプリが動いている間に置いてよい。ON にしたときに SHA-256 を照らし直す
- `net up` はポート 18080 を使う。検証用の Kura は同時に1つだけなので、プロキシも1つ。`stop` はプロキシも止める
- プロキシは curl だけに効く。Kura の外への通信は curl のモデルのダウンロードだけなので、これで足りる。ほかの経路が足されたら、この手順を見直す
- `lsof` と `proxy.log` で見えるのは、Kura とその子プロセスの通信だけ。WKWebView は外の URL を読まない（画面は `.app` の中）
- 計算の1枚は約50ms（リリース用ビルド、1スレッド）。2万枚で約16分。計算中はワーカーが1コアを使い切る
- 単色の画像は構図の値がすべて0になる。基準にすると、重みを変えても並びが変わらない（作りのとおり）。並びの確認には使わない
- 再起動の後に残るか（重み、計算の続き）は `relaunch` で確かめる。`stop` すると home ごと settings.json も消える。`relaunch` は `KURA_PROXY` を引き継がないので、プロキシに通すなら付け直す
- ライブラリの切り替えで計算は止まり、戻ると続きから。2つのライブラリの `features.db` の hash は、それぞれの `kura.db` の `images.hash` にだけある
