# フェーズ3のまとまりとブリーフ

2026-11-15 作成。実装開始時に使う依頼案です。進行役のメインセッションが、まとまりごとにサブセッションを始めます。

## まとまり

[phase3.md](phase3.md) のタスク1〜11（3a）を、1回のセッションで頼める大きさのまとまりに分けています。タスク0（スパイク）は済んでいます。タスク2、4、5 の作り方は [phase3-design.md](phase3-design.md) に決めてあります。

| まとまり | タスク | 内容 | 前提 | 並行 | ブランチ |
| --- | --- | --- | --- | --- | --- |
| A | 1 | `ml/` のワーカーと `model.json`、CI | なし | B と並行できる | `feat/phase3-worker` |
| B | 4 | `features.db`（Rust） | なし | A と並行できる | `feat/phase3-features-db` |
| C | 2 | ワーカーの同梱、起動・再起動・終了 | A、B | しない | `feat/phase3-worker-process` |
| D | 3 | ON/OFF の設定とモデルのダウンロード | C | しない | `feat/phase3-enable` |
| E | 5 | バックグラウンドの計算 | B、C、D | しない | `feat/phase3-calc` |
| F | 6 | 類似度を返すコマンドと実測 | E | しない | `feat/phase3-search` |
| G | 7、8 | 入口、結果のモード、重みのスライダー | F | しない | `feat/phase3-search-ui` |
| H | 9、10 | 実アプリの検証手順、利用者向け文書とリリース準備 | G | しない | `feat/phase3-release-prep` |
| I | 12 | 3b の準備（未決事項を利用者に質問する） | タスク11 | - | 3b の開始時に決める |
| J | 13 | ポーズの特徴量の計算 | I | - | 同上 |
| K | 14 | ポーズの類似度とスライダー | J | - | 同上 |
| L | 15 | 3b の検証手順、文書、リリース準備 | K | - | 同上 |

分け方の理由：

- A と B は触るファイルが重ならない（`ml/` と CI、`src-tauri/src/` の `manifest.rs`・`features.rs`・`library.rs`・`trash.rs`・`sync.rs`）。並行するときは、B が `.github/workflows/ci.yml` に触れないこと
- C、D、E、F はどれも `main.rs`、`src/mocks/ipc.ts`、`tauri.conf.json` か `Cargo.toml` に触れるので、並行にしない
- G：重みのスライダーは結果のモードの帯に置き、並べ替えも同じ画面の状態を使うので、1度に作る
- H：どちらも、作った機能を通して確かめる作業と文書の作業で、新しい機能を足さない
- I〜L は枠だけ置く。中身は、タスク12で骨格推定のモデルと複数人の扱いを利用者と決めてから書く。ここでは決めない

各まとまりのブランチは `feat/phase3-similarity` の最新から切り、終わったら `feat/phase3-similarity` へマージします。main には、3a の確認（タスク11）が済んでから入れます（2026-11-15 に利用者と決めた）。A と B を並行したときは、先に終わった方をマージし、後の方はマージの前に `feat/phase3-similarity` の最新を取り込みます。

タスク11は利用者とメインセッションで行います。まとまりが大きすぎると分かったら、未検証の部分を隠さず報告してから、次の依頼をさらに分けます。各ブランチは途中段階であり、フェーズ3全体の完成を意味しません。

## 貼り付ける共通ブリーフ

`<記号>`、`<番号>`、`<ブランチ>` を上の表から埋め、続けて下の「まとまりごとのブリーフ」の該当する文面を貼ります。必要なら前のまとまりの報告と統合済みコミットを添えます。

```text
Kura のフェーズ3、docs/tasks/phase3-sessions.md のまとまり <記号>（docs/tasks/phase3.md のタスク <番号>）を担当してください。

最初に ls ~/.claude/plugins/cache/cursor-plugins/pstack/ でインストール済みの版を確認し、
~/.claude/plugins/cache/cursor-plugins/pstack/<版>/skills/poteto-mode/SKILL.md を全部読んでください。
サブセッションでは /poteto-mode は自動で読み込まれません。

続いて CLAUDE.md、docs/requirements.md の4章・5.6・7章、docs/design.md、docs/development.md、
docs/tasks/phase3.md、docs/tasks/phase3-check.md、docs/tasks/phase3-design.md、このブリーフを読んでください。

最初に git status と現在のブランチを確認し、feat/phase3-similarity の最新を基点に
ブランチ <ブランチ> で対象のタスクだけを進めてください。
既存の変更を捨てず、無関係な変更を含めないでください。

作り方は docs/tasks/phase3-design.md に決めてあります。型、関数の名前、JSON の行、
失敗時の動きは、そこに書いてあるとおりに作ってください。
書いていない判断が要るとき、設計メモとコードが食い違うとき、設計メモのとおりに作れないと分かったときは、
実装で決めずに、止まって報告してください。要件定義書の未決事項（10章）も実装で決めません。
テストは、設計メモの「先に書くテスト」を先に書き、失敗するのを見てから実装してください。
必要な変更、対応する検証、利用者向け文書の更新まで行い、結果を報告して止まってください。
区切りごとにコミットし、各コミットでテストが通る状態にしてください。コミットメッセージには対象のIDを入れてください。

サブセッションはマージも push もしません。タグの作成・push やリリース、GitHub Release へのファイルの追加も行いません。
頼まれても「マージと push はメインセッションに任せます」と答え、報告して止まってください。

本物の資料フォルダ ~/Pictures/References には触れません。読み取りもしません。
見本の写真 /Users/kk6/Projects/kura-library は読むだけにし、ライブラリとして開かず、中身を変えません。
開発・検証は生成したダミー画像と隔離した設定・履歴で行ってください。
画像は docs/images/ のスクリーンショット以外コミットしません。モデルのファイルもコミットしません。

外への通信は、利用者が設定で ON にしたときのモデルのダウンロードだけです（NFR-08）。
テストと CI ではモデルをダウンロードしません。偽の小さなモデルをテストの中で作ってください。
ライブラリに書き込むのは Rust だけです。Python は画像を読んで特徴量を返すだけにします。
spikes/ のコードを本体から参照しません。同じ計算が要るときは、ml/ に書き直してください。
Rust 本体では println! を使わず、ログは log のマクロで出してください。
コードのコメントは、ほかのファイルと同じく日本語で書いてください（ライセンス文などの引用は除く）。

e2e（Playwright＋モック）は Rust、ワーカー、ダウンロード、features.db を検証できません。
Rust のコマンドや DB、ワーカーを変えたら .claude/skills/verify-kura/SKILL.md を読み、
実アプリを隔離して操作し、画面・DB・ファイル・ログ・プロセスの証跡を残してください。
library.rs の connect と apply_op、fileops.rs、pending_ops に触れたら
.claude/skills/verify-crash-safe-move/check.sh を実行してください。
DRIFT が出たら、その SKILL.md に従ってモデルを合わせてください。
マージ前には利用者が実アプリで確認します。未確認を合格扱いにしないでください。

e2e はポート5173を使います。利用者の npm run tauri dev と競合させず、
既存プロセスを勝手に止めないでください。
性能（NFR-01、NFR-03）は npm run tauri build のリリース用ビルドで測ってください。
ruff は uvx ruff@0.17.3（ruff.toml の固定版）を使ってください。
lefthook はコミット時に整形・検査を実行します。

画面の動作や文言を変えたら同じタスクで docs/user-guide.md も直してください。
Tauri のコマンドを足したら、main.rs の generate_handler!、src/mocks/ipc.ts、画面の invoke をそろえてください
（npm run lint が確かめます）。npm のコマンドを足したら CLAUDE.md の「コマンド」に書いてください。

報告には、ブランチ・基点・変更（コミットID）、対象タスクと要件ID、
検査コマンドと結果、実アプリの証跡の場所、phase3-check の対応項目、
利用者が確かめる操作、設計メモと違う作りにした所（あれば理由）、未確認・制約・残る課題を含めてください。
```

## まとまりごとのブリーフ

### A（タスク1）：ワーカー

- 触るファイル：`ml/`（新規）、`.github/workflows/ci.yml`（python ジョブ）、`.gitignore`、`ruff.toml`（対象に `ml/` が入っているかの確認だけ）、CLAUDE.md
- 完了の条件：phase3.md のタスク1の「終わったと言える状態」。設計メモ1章の「先に書くテスト」の `ml/` の分がすべて通る

```text
まとまり A は、Python のワーカーを ml/ に作ります。Rust には触れません。

- やりとりの形は設計メモの1章「やりとりの形」、model.json は0章「観点の定義」、構図のベクトルは0章「構図のベクトル」のとおりです
- パッケージ名は kura_worker、入口は python -m kura_worker と、pyproject.toml の scripts の kura-worker の両方で起動できるようにしてください
- 依存は onnxruntime、numpy、pillow だけです。uv.lock をコミットしてください
- pyproject.toml に build-system を書き、uv sync --project ml で kura_worker が ml/.venv にパッケージとして入るようにしてください。
  リポジトリのルートから ml/.venv/bin/python -m kura_worker で起動できることを確かめます（開発版の Rust がこの形で起動します）
- 内容の前処理と、構図の gray・edge の計算は、spikes/similarity/features.py の siglip2-b16 の preprocess、embed、comp_gray、comp_edge、load と同じ結果になるように ml/ に書き直してください。import はしません
- ONNX Runtime は CPUExecutionProvider、intra_op_num_threads は model.json の threads です
- model.json の sha256 と size は、spikes/similarity/models/siglip2-b16.onnx から計算して入れてください。このファイルがなければ、ダウンロードせずに報告してください
- pytest では本物のモデルを使いません。テストの中で、入力（1×3×224×224）から決まった長さの出力（pooler_output）を返す小さな ONNX を作ります。onnx のパッケージが要るなら、開発用の依存（dependency-groups の dev）にだけ足してください
- 本物のモデルでの確認は、pytest とは別に手で1回行います。spikes/similarity/models/ をモデルのフォルダとして渡し、ダミー画像1枚の結果が、768個と384個の有限の数で、どちらも長さ1であることを報告してください
- CI の python ジョブに、ml/ での uv run pytest を足してください。CLAUDE.md の CI の説明の「ml/ の pytest は ml/ ができてから足す」も直してください
```

### B（タスク4）：features.db

- 触るファイル：`src-tauri/src/manifest.rs`（新規）、`src-tauri/src/features.rs`（新規）、`library.rs`、`trash.rs`、`sync.rs`、`main.rs`（`mod` の2行と `allow_assets`）
- 完了の条件：phase3.md のタスク4の「終わったと言える状態」。設計メモ2章の「先に書くテスト」がすべて通る。`check.sh` が通る

```text
まとまり B は、特徴量を .kura/features.db に保存する処理を Rust に作ります。ワーカーにも画面にも触れません。

- 作り方は設計メモの2章のとおりです。Manifest、Aspect、ModelFile の型と read は、0章「観点の定義」のとおり manifest.rs に置きます
- ml/model.json はまとまり A が作ります。このまとまりの本体のコードでは読みません。
  manifest::read のテストは、0章の例と同じ形の JSON をテストの中で書いて読ませてください
- Store の関数のうち、このまとまりの本体のコードから呼ぶのは forget_features の中の remove だけです。
  残りはまとまり E と F が使います。使われていない警告は、0章「まだ呼ばれないコードの警告」のとおりに止めてください
- 2万件の特徴量（乱数）を入れた features.db で、quick_check の時間を測って報告してください（2章「先に書くテスト」の最後）
- library.rs の connect を変えるので、.claude/skills/verify-crash-safe-move/check.sh を流してください
- 実アプリ（verify-kura）では、完全削除と「一覧から外す」が今までどおり動くこと、
  features.db のないライブラリに features.db ができないことを確かめてください
- .github/workflows/ci.yml には触れないでください（まとまり A と並行するため）
```

### C（タスク2）：ワーカーの同梱と起動

- 触るファイル：`src-tauri/src/worker.rs`（新規）、`main.rs`、`build.rs`、`tauri.conf.json`、`package.json`、`.gitignore`、`.github/workflows/release.yml`、CLAUDE.md、`docs/development.md`
- 完了の条件：phase3.md のタスク2の「終わったと言える状態」のうち、「リリース用ビルドの `.app` を、uv のない `PATH` で起動してワーカーとやりとりできる」。設計メモ1章の「先に書くテスト」の `worker.rs` の分と、実アプリの分が通る。「OFF の間はワーカーを起動しない」は、起動する側（まとまり E）で確かめる

```text
まとまり C は、ワーカーを .app に同梱し、Rust から起動する worker.rs を作ります。

- 作り方は設計メモの1章のとおりです
- 最初に、1章「同梱とビルド」の「タスク2の最初に確かめる」を行ってください。
  ml/dist/kura-worker/ がない状態で npm run tauri dev と cargo test（src-tauri/）が通るかを、書いてある順に試します
- このまとまりでは、worker.rs を呼ぶ本体のコードをまだ作りません（呼ぶのはまとまり E の calc）。
  main.rs に足すのは、Spec と model.json の場所を作る関数と mod worker; だけです。
  使われていない警告は、0章「まだ呼ばれないコードの警告」のとおりに止めてください
- .app の中のワーカーは、1章「同梱したワーカーの確認」の #[ignore] を付けたテストで確かめます。
  モデルは spikes/similarity/models/siglip2-b16.onnx を、model.json の file.name の名前で一時フォルダに写して渡してください
- release.yml を変えますが、タグの push はしません。ワークフローは実行せずに、変更した手順を報告してください
- npm run worker:build と、開発版の準備（uv sync --project ml）を CLAUDE.md の「コマンド」と docs/development.md に書いてください
- できた .app の大きさと、worker:build にかかった時間を報告してください
```

### D（タスク3）：ON/OFF とモデルのダウンロード

- 触るファイル：`src-tauri/src/settings.rs`、`src-tauri/src/model.rs`（新規）、`main.rs`、`src/` の設定ダイアログと設定の型、`src/mocks/ipc.ts`、`e2e/`、`docs/user-guide.md`
- 完了の条件：phase3.md のタスク3の「終わったと言える状態」。phase3-check の A のうち、入口とワーカーに関わらない項目を実アプリで確かめている

```text
まとまり D は、設定の「類似画像検索を使う」と、モデルのダウンロードを作ります。仕様は要件定義書の5.6「有効化とモデルの取得」です。

- 設定の項目は Settings に similarity_enabled: bool（初期値 false）を足します。重みはまとまり G が足します
- ダウンロードするファイルは、model.json の aspects のうち file が null でないものです。
  置き場所は main.rs の app_file(app, "models") の下で、名前は file.name です（開発版は debug/models/ になります）
- ON にする流れ：(1) 画面が大きさ（file.size の合計）を見せて確認する (2) すでに全部のファイルがあり、
  SHA-256 が合っていれば、通信せずに ON にする (3) なければダウンロードし、SHA-256 を確かめ、
  <名前>.part に書いてから置き換える (4) 全部そろってから similarity_enabled を true で保存する。
  失敗したら .part を消し、エラーと「再試行」を出し、ON にしない。途中からの再開は作らない
- ダウンロードは /usr/bin/curl を std::process::Command で起動して行います（-f -L --output <.part>）。
  HTTP のクレートを足さないためです。進み具合は、.part の大きさを file.size と比べて、イベントで画面に送ります。
  キャンセルは作りません。curl で要件を満たせないと分かったら、クレートを足さずに報告してください
- テストでは通信しません。ダウンロードの関数は URL を引数に取り、テストでは file:// の URL を渡します。
  先に書くテスト：ファイルができ、SHA-256 が合う／SHA-256 が違うと失敗し、.part も本体も残らない／
  URL が開けないと失敗し、前からあった正しいファイルを壊さない／全部そろっていれば curl を起動しない
- OFF に戻しても、モデルと特徴量は消しません。OFF の間は入口を隠します（入口そのものはまとまり G が作ります）
- 計算を始める・止める合図（calc）はまとまり E が作ります。このまとまりでは save_settings に足しません
- GitHub Release の models-1 にはまだファイルがありません。実アプリでは、(a) 手で models/ に置いたモデルで、
  通信せずに ON にできること (b) 今の URL（まだ無い）で失敗し、エラーと「再試行」が出て ON にならないこと
  を確かめてください。本物の URL からのダウンロードは、利用者がファイルを置いた後にメインセッションが確かめます
```

### E（タスク5）：バックグラウンドの計算

- 触るファイル：`src-tauri/src/calc.rs`（新規）、`main.rs`、`library.rs`（`NOT_OPEN`、`DRIVE_UNREADABLE`）、`worker.rs` と `features.rs`（`#[allow(dead_code)]` を外す）、`src/` のステータスバーと設定ダイアログ、`src/mocks/ipc.ts`、`e2e/`、`docs/user-guide.md`
- 完了の条件：phase3.md のタスク5の「終わったと言える状態」。設計メモ3章の「先に書くテスト」がすべて通る。phase3-check の B と、A の「OFF の間はワーカーのプロセスも動いていない」を実アプリで確かめている

```text
まとまり E は、未計算の画像をバックグラウンドで計算する calc.rs と、その画面（ステータスバー、設定の計算状況と「再計算」）を作ります。

- 作り方は設計メモの3章のとおりです。1章（worker）と2章（features）の関数を使います
- 3章「きっかけ」の表のすべての場所に、wake・halt・retry を足してください
- 実アプリの確認は、3章「先に書くテスト」の実アプリの分を、verify-kura の隔離した環境で行ってください。
  モデルは spikes/similarity/models/siglip2-b16.onnx を、model.json の file.name の名前で隔離した models/ に写します
- 2万枚の計測はリリース用ビルドで行い、1枚あたりの時間、2万枚にかかった時間、計算中のスクロール（NFR-01）を報告してください。
  スレッド数（model.json の threads）は変えずに測ります。増やすかどうかは利用者が決めます
```

### F（タスク6）：類似度を返すコマンド

- 触るファイル：`src-tauri/src/similar.rs`（新規）、`main.rs`、`features.rs`、`src/mocks/ipc.ts`、`docs/requirements.md`（4章の実測値）
- 完了の条件：phase3.md のタスク6の「終わったと言える状態」

```text
まとまり F は、基準画像に対する観点ごとの類似度を返す Rust のコマンド similar_images を作ります。画面はまとまり G が作ります。

- 引数は基準画像の id。返り値は次の形です
  { "aspects": ["content", "composition"], "ids": [画像の id…], "scores": [[content の値…], [composition の値…]], "uncomputed": 未計算の枚数 }
  ids と scores の各配列は同じ長さ・同じ並びです。aspects の並びは model.json と同じです
- 対象は、ゴミ箱でも「見つからない」でもなく、すべての観点の特徴量がある画像です。基準画像も ids に入れます。
  uncomputed は、ゴミ箱でも「見つからない」でもなく、特徴量がそろっていない画像の数です
- 類似度はコサイン類似度（ベクトルは長さ1なので内積）です。観点ごとに、基準画像を除いた全画像の値で平均0・標準偏差1にそろえます。
  標準偏差が0のとき、対象が基準画像だけのときは、すべて0にします。基準画像の値も同じ式でそろえます
- 基準画像がゴミ箱・「見つからない」・未計算のときは Err にします
- 特徴量は features::Store::load で読みます。ワーカーは使いません。重みは受け取りません（掛けるのは画面）
- 先に書くテスト：自分に近いベクトルの画像ほど値が大きい／そろえた後の平均が0で標準偏差が1／
  ゴミ箱・「見つからない」・未計算の画像が ids にない／uncomputed が合う／基準画像が未計算なら Err／
  観点の片方しかない画像は未計算として扱う
- 2万件のダミーの特徴量（乱数）を features.db に入れ、リリース用ビルドで、コマンドを呼んでから結果が返るまでを測ってください。
  2秒（NFR-03）を超えたら、速くする工夫を足さずに報告してください。実測値は要件定義書の4章に書き戻します
- src/mocks/ipc.ts に、同じ形のモックの応答を足してください（画面の invoke はまとまり G が足すので、
  npm run lint のコマンド名の検査が通る形を docs/development.md と scripts/check-docs.mjs で確かめてください。
  通らないなら、止まって報告してください）
```

### G（タスク7、8）：入口、結果のモード、重み

- 触るファイル：`src/`（詳細パネル、右クリックメニュー、一覧、帯、設定の型）、`src/mocks/ipc.ts`、`src-tauri/src/settings.rs`（重み）、`e2e/`、`docs/user-guide.md`、`docs/design.md`（帯とスライダーの決まりが要るとき）
- 完了の条件：phase3.md のタスク7と8の「終わったと言える状態」。重みの計算の単体テスト（Vitest）と e2e が通る。phase3-check の C、D、E を実アプリで確かめている

```text
まとまり G は、「似た画像を探す」の入口、結果のモード、重みのスライダーを画面に作ります。仕様は要件定義書の5.6「入口と結果」と「重み」です。

- 類似度はまとまり F のコマンド similar_images が返します。画面は、観点ごとの値に重みを掛けて足し、大きい順に並べます。
  基準画像は値によらず先頭に置きます
- 重みは Settings に similarity_weights（観点の名前 → 0〜100 の整数）として保存します。
  無い観点は初期値（どの観点も同じ値）で埋めます。3b で観点が増えても、保存した値を壊さない形にしてください
- 入口は、設定の similarity_enabled が false のときは出しません
- docs/design.md を先に読み、帯とスライダーに使う色・余白はトークンだけにしてください。足りない決まりがあれば、
  画面を作る前に報告してください
- 見た目は、モックの開発サーバーを Playwright で開いてスクリーンショットで確かめます。
  既存の画面が変わっていないことは、CLAUDE.md の「見た目が変わっていないことの確認」の手順で確かめてください
- 2万枚で、スライダーを動かしても一覧が引っかからないことを、リリース用ビルドで確かめてください
```

### H（タスク9、10）：検証手順と文書、リリース準備

- 触るファイル：`.claude/skills/verify-kura/`、`docs/user-guide.md`、`README.md`、`homepage/`、`docs/images/`、`CHANGELOG.md`、CLAUDE.md、`docs/tasks/phase3-check.md`
- 完了の条件：phase3.md のタスク9と10の「終わったと言える状態」

```text
まとまり H は、実アプリの検証手順と、利用者向けの文書・リリースの準備をそろえます。新しい機能は足しません。

- verify-kura に features/similarity.md を足します。隔離した環境にモデルを置く手順、ダウンロードを失敗させる手順と元に戻す手順、
  2万件の特徴量を入れたダミーのライブラリを作る手順を書き、実際に流して確かめてください
- phase3-check の A〜G の各項目について、必要な操作と証跡がそろっているかを確かめ、足りない準備を報告してください
- モデル（SigLIP 2、Apache-2.0）のライセンスの写しと著作権表示を、モデルと一緒に GitHub Release に置く形で用意してください。
  アプリの中と README のどこに表記するかは、案を出して利用者に確かめてから書きます
- モデルのファイルを GitHub Release（タグ models-1）に置く手順を CLAUDE.md の「リリース」に書きます。
  置く操作そのものは利用者が行います
- 版は利用者が決めます。決まるまで npm run version:set を実行しないでください
- スクリーンショットを撮り直すときは、KURA_DOCS_PHOTOS=/Users/kk6/Projects/kura-library npm run docs:screenshots を使います
```

## メインセッションの統合手順

1. 報告を受けたら、`git status`、現在のブランチ、基点からの差分とコミットを確認する。対象タスク以外の変更や、未保存の利用者の変更を混ぜない
2. 報告の「設計メモと違う作りにした所」を読み、[phase3-design.md](phase3-design.md) と差分を突き合わせる。違いを認めるなら設計メモを直し、認めないなら同じサブセッションに直させる
3. `.github/workflows/ci.yml` を読んで、変更に対応する CI と同じコマンドを手元で実行する。実行時の CI 定義を正本にする
4. 実アプリの証跡を確認し、利用者が [phase3-check.md](phase3-check.md) の該当箇所を実アプリで確かめる。ワーカー、ダウンロード、`features.db`、計算中の操作を、モックの合格だけで済ませない
5. 検査結果と具体的な差分を示し、利用者の許可を得て `feat/phase3-similarity` へマージする。サブセッション側ではマージしない
6. `feat/phase3-similarity` を push して対象コミットの CI を確認する。失敗は解消してから次のまとまりへ進む
7. 決まったことを `docs/requirements.md` に書き戻し、[phase3.md](phase3.md) の「進み具合」を進める

リリースのタグの push と、GitHub Release へのモデルの追加は、通常の統合とは別に扱い、利用者の判断まで行いません。
