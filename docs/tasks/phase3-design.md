# フェーズ3の設計メモ（タスク2、4、5）

2026-11-15 作成。[phase3.md](phase3.md) のタスク2（ワーカーの起動・再起動・終了）、タスク4（`features.db`）、タスク5（バックグラウンドの計算）を、設計の判断をせずに実装するための文書です。仕様は [requirements.md](../requirements.md) の4章・5.6・7章が正本で、この文書は作り方を決めます。

この文書に書いていない判断が要るときは、実装で決めずに、止まってメインセッションに報告します。この文書とコードが食い違ったときも同じです。

## 0. 全体の形

### モジュールと役割

| モジュール | 場所 | 役割 | 呼ぶ側が知ること |
| --- | --- | --- | --- |
| ワーカー | `ml/`（Python） | サムネイルを読み、観点ごとのベクトルを返す。ファイルも DB も書かない | 1行1件の JSON（1章） |
| `worker` | `src-tauri/src/worker.rs` | ワーカーのプロセスを1つ起動し、1件ずつ要求して結果を受け取る。落ちた・返事がない・壊れた行を1つのエラーにまとめる | `Worker::start`、`compute`、`Failure` |
| `manifest` | `src-tauri/src/manifest.rs` | `ml/model.json` を読む。`Manifest`、`Aspect`、`ModelFile` の型を持つ | `manifest::read(path)` |
| `features` | `src-tauri/src/features.rs` | `.kura/features.db` の作成・作り直し・読み書き | `Store` の6つの関数 |
| `calc` | `src-tauri/src/calc.rs` | 未計算の画像を1本のスレッドで順に計算して保存する。ライブラリの切り替え・ON/OFF・失敗を扱う | `wake`、`halt`、`retry`、`status` |

`calc` は `worker` と `features` を使います。`worker` と `features` は互いを知りません。類似度を返すコマンド（タスク6）は `features` だけを使い、ワーカーを使いません。

### 観点の定義（`ml/model.json`）

モデルの名前・次元・ダウンロード元・スレッド数は、`ml/model.json` の1か所に置きます。Rust とワーカーの両方がこのファイルを読みます。モデルを入れ替えるときは、このファイルとワーカーのコードを変え、Rust のコードは変えません（NFR-11）。タスク1で作ります。

```json
{
  "threads": 1,
  "aspects": [
    {
      "aspect": "content",
      "model": "siglip2-base-patch16-224",
      "dim": 768,
      "file": {
        "name": "siglip2-base-patch16-224-vision.onnx",
        "url": "https://github.com/kk6/kura/releases/download/models-1/siglip2-base-patch16-224-vision.onnx",
        "sha256": "<spikes/similarity/models/siglip2-b16.onnx の SHA-256>",
        "size": 0
      }
    },
    { "aspect": "composition", "model": "gray16-edge4x8-v1", "dim": 384, "file": null }
  ]
}
```

- `aspect` は `features.db` の観点の列に入る値。`model` はモデル名の列に入る値で、計算の方法を変えたら必ず変える（古い行を計算し直す目印になる）
- `file` は、ダウンロードするモデルのファイル。学習済みモデルを使わない観点は `null`。`size` はバイト数で、タスク1で実際の値を入れる
- `threads` は ONNX Runtime の `intra_op_num_threads`。1で始める（2026-11-15 に利用者と決めた。増やすのは、計算中のスクロールを測ってから相談する）
- 前処理の値（224×224 に縮める、平均と標準偏差が 0.5 など）は `model.json` に置かず、ワーカーのコードに `model` の名前ごとに書く。モデルを変えるとワーカーのコードも変わるため
- Rust は `serde` で `Manifest { threads, aspects: Vec<Aspect> }` として読む。`Aspect { aspect, model, dim, file: Option<ModelFile> }`。型と `pub fn read(path: &Path) -> Result<Manifest, String>` は `src-tauri/src/manifest.rs` に置き、`features`、`worker`、`calc` が同じ型を使う。作るのはタスク4（Rust で最初に進めるまとまり B）
- 読むのはアプリの起動時に1回（`main.rs` の `.setup`）。読めない・壊れているときは `log::error!` に残し、`calc` の `enabled` を常に false にする（類似画像検索を使えないだけで、アプリは起動する）。設定を ON にする操作（タスク3）は、読めなかった理由を `Err` で返す

### まだ呼ばれないコードの警告

`manifest`、`features`、`worker` は、`calc`（タスク5）と検索のコマンド（タスク6）ができるまで、本体のどこからも呼ばれません。CI は `cargo clippy -- -D warnings` なので、使われていない関数は警告で落ちます。呼ぶ側ができるまでは、使われていない項目ごとに `#[allow(dead_code)]` を付け、すぐ上に「タスク5の calc が使う」のように理由を1行で書きます。タスク5で `load` 以外を、タスク6で `load` を外します。モジュール全体にまとめて付けません

`model.json` の場所：

| ビルド | 場所 |
| --- | --- |
| 開発版（`cfg!(debug_assertions)`） | `concat!(env!("CARGO_MANIFEST_DIR"), "/../ml/model.json")` |
| リリース版 | `app.path().resource_dir()` の `worker/model.json` |

モデルのファイルの置き場所は、どちらのビルドも `main.rs` の `app_file(app, "models")` の下（開発版は既存の決まりで `debug/models/` になる）。置くのはタスク3です。

### 構図のベクトル

構図は、スパイクの gray（256次元）と edge（128次元）を、それぞれ長さ1にそろえてから `1/√2` 倍し、gray、edge の順につなげた384次元のベクトルにします。このベクトルどうしのコサイン類似度は、スパイクで選んだ「2つの類似度の平均」と同じ値になります。Rust は内容と構図を区別せず、どの観点も「ベクトル1つのコサイン類似度」として扱います。

## 1. タスク2：ワーカーの起動・再起動・終了

### やりとりの形（Rust と Python）

起動の引数：

```
kura-worker --manifest <model.json の絶対パス> --model-dir <モデルのフォルダの絶対パス>
```

標準入力と標準出力は UTF-8 で、1行に1つの JSON を書き、行ごとに flush します。標準出力にはこの表の行だけを書きます。ログは標準エラーに書きます。

| 向き | いつ | 行 |
| --- | --- | --- |
| Python → Rust | モデルを読み込み終えたとき（1回） | `{"ready": true, "protocol": 1, "aspects": [{"aspect": "content", "model": "siglip2-base-patch16-224", "dim": 768}, {"aspect": "composition", "model": "gray16-edge4x8-v1", "dim": 384}]}` |
| Python → Rust | 起動に失敗したとき（モデルがない、読めないなど）。出した後に終了コード1で終わる | `{"ready": false, "error": "<理由>"}` |
| Rust → Python | 1枚の計算 | `{"id": 1, "path": "<サムネイルの絶対パス>"}` |
| Python → Rust | 計算できた | `{"id": 1, "ok": true, "features": {"content": [0.01, ...], "composition": [0.02, ...]}}` |
| Python → Rust | その画像を計算できなかった（読めない、画像でない）。ワーカーは止まらない | `{"id": 1, "ok": false, "error": "<理由>"}` |

- ベクトルは数値の配列で、長さは `dim`、どの値も有限。ワーカーは長さ1にそろえてから返す（構図は上の節の形）
- `id` は Rust が1から順に付ける整数。ワーカーは受け取った `id` をそのまま返す
- `aspects` の並びは `model.json` と同じ
- ワーカーは標準入力が閉じたら（EOF）、終了コード0で終わる。Rust のプロセスがどう終わっても、ワーカーは残らない
- ワーカーが受け取った行を JSON として読めないとき、`id` か `path` がないときは、標準エラーに書いて終了コード1で終わる（Rust 側の不具合なので、続けない）
- 知らないキーは、どちらの側も無視する

### Rust 側の持ち方（`worker.rs`）

```rust
/// 何を起動するか。テストでは偽のワーカーを指す
pub struct Spec { pub program: PathBuf, pub args: Vec<OsString> }

pub struct Timeouts { pub ready: Duration, pub reply: Duration }   // 本体は ready 60秒、reply 30秒

pub enum Failure {
    /// その画像だけ計算できなかった。ワーカーは生きている
    Image(String),
    /// ワーカーが使えなくなった（落ちた、返事がない、決まりと違う行）。この Worker は捨てる
    Dead(String),
}

pub struct Worker { /* Child、ChildStdin、行を受け取る Receiver<String>、次の id、aspects、Timeouts */ }

impl Worker {
    /// 起動して ready を待ち、aspects が expected と同じことを確かめる
    pub fn start(spec: &Spec, expected: &[Aspect], timeouts: Timeouts) -> Result<Worker, String>;
    /// 1枚を計算する。返り値は expected と同じ順・同じ数のベクトル
    pub fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, Failure>;
}

impl Drop for Worker { /* kill してから wait する。読むスレッドは join しない */ }
```

- 起動は `std::process::Command`（標準入力と標準出力と標準エラーを pipe にする）。`tauri-plugin-shell` は使わない
- 標準出力は、起動時に作るスレッドが1行ずつ読んで `mpsc` のチャンネルに送る。`start` と `compute` は `recv_timeout` で待つ。チャンネルが閉じたら、ワーカーが終わったものとして扱う
- 標準エラーは、もう1本のスレッドが1行ずつ読んで `log::warn!` に出す（pipe が詰まってワーカーが止まらないようにするため）
- 要求は一度に1件だけ出す。`compute` は返事を受け取るまで戻らない
- `Worker` は `calc` のスレッドだけが持つ。`Mutex` にも Tauri の State にも入れない
- 終わらせ方は `Drop` の1つだけ（kill して wait）。ワーカーは保存する状態を持たないので、穏やかな終了を待たない。読むスレッドは、パイプが閉じると自分で終わるので join しない（ワーカーが子のプロセスにパイプを渡していると、join は戻らない）
- `start` が `Err` を返すときも、起動したプロセスを kill して wait してから返す

`Spec` を作る関数は `main.rs` に置きます（`AppHandle` が要るため）。

| ビルド | program | args |
| --- | --- | --- |
| 開発版（`cfg!(debug_assertions)`） | `<CARGO_MANIFEST_DIR>/../ml/.venv/bin/python` | `-m kura_worker --manifest … --model-dir …` |
| リリース版 | `resource_dir()` の `worker/kura-worker` | `--manifest … --model-dir …` |

開発版は、初回に `uv sync --project ml` で `.venv` を作っておきます。`kura_worker` は `.venv` にパッケージとして入るので（タスク1で `pyproject.toml` に build-system を書く）、作業フォルダは指定しません。`Spec` を作る関数は、開発版のときだけ `program` があるかを確かめ、なければ「`ml/` で `uv sync` を実行してください」の `Err` を返します（`worker.rs` は開発版かどうかを知らない）。CLAUDE.md の「コマンド」に書きます。

### 同梱とビルド

- `package.json` に `worker:build` を足す：`uv run --project ml --with pyinstaller pyinstaller --onedir --noconfirm --name kura-worker --distpath ml/dist --workpath ml/build --specpath ml/build <ワーカーの入口のファイル>`。できるのは `ml/dist/kura-worker/`（実行ファイル `kura-worker` と `_internal/`）。`ml/dist/` と `ml/build/` は `.gitignore` に足す
- `tauri.conf.json` の `bundle.resources`：`{ "../ml/dist/kura-worker/": "worker/", "../ml/model.json": "worker/model.json" }`
- `tauri.conf.json` の `beforeBuildCommand`：`npm run build && npm run worker:build`。`npm run tauri build` だけでワーカーも入る。`release.yml` には、外部のアクション（`astral-sh/setup-uv`）を使わずに uv を入れる手順（`brew install uv`）を足す。書き込み権限を持つジョブで外部のアクションを増やさない、既存の決まりに合わせる。ランナーで通るかは確かめていないので、手順を報告に書く
- `tauri dev` と `cargo test` はワーカーをビルドしない。`ml/dist/kura-worker/` がないと Tauri のビルドが止まるかは確かめていない。**タスク2の最初に確かめる**。次の順に試し、通った最初の方法を使う
  1. 何もしなくても通る
  2. `src-tauri/build.rs` の `tauri_build::build()` の前で、`../ml/dist/kura-worker` を `create_dir_all` する
  3. 2 に加えて、フォルダが空なら `.placeholder` という空のファイルを書く
  4. どれも通らなければ、止まってメインセッションに報告する
- CI の rust ジョブは今のまま（ワーカーをビルドしない）で通ること

### 失敗時の動き

| 起きたこと | `worker` の返り値 | その後 |
| --- | --- | --- |
| `program` がない、起動できない | `start` が `Err` | `calc` がエラーを出して止まる（3章） |
| `{"ready": false, …}` が来た | `start` が `Err(error の文)` | 同上 |
| ready の前にプロセスが終わった、60秒待っても ready が来ない | `start` が `Err` | 同上。待ち切れたときは kill する |
| ready の `protocol` が1でない、`aspects` が `expected` と違う（観点、モデル名、次元、並び） | `start` が `Err` | 同上。アプリとワーカーの版が合っていない |
| `{"ok": false}` が来た | `compute` が `Failure::Image` | `calc` がその画像を失敗に数えて次へ進む |
| 要求を書けない、返事の前にプロセスが終わった | `compute` が `Failure::Dead` | `calc` がその画像を失敗に数え、計算を止めてエラーを出す |
| 30秒待っても返事が来ない | `compute` が `Failure::Dead` | 同上 |
| JSON でない行、`id` が違う、観点が足りない、長さが `dim` と違う、有限でない値がある | `compute` が `Failure::Dead` | 同上。決まりを破ったワーカーを使い続けない |

`worker` は自分では起動し直しません。`calc` が次のきっかけで新しい `Worker` を作ります（3章）。

### 先に書くテスト

`ml/`（pytest。タスク1。偽の小さな ONNX モデルをテストの中で作る）：

- ready の行に、`model.json` と同じ観点・モデル名・次元が並ぶ
- 画像1枚を渡すと、観点ごとに `dim` と同じ長さで、長さ1のベクトルが返る
- 構図のベクトルどうしの内積が、gray と edge のコサイン類似度の平均に等しい
- 読めないパス、画像でないファイルで、`ok: false` が返り、次の要求に答える
- 標準入力を閉じると、終了コード0で終わる
- モデルのファイルがないと、`ready: false` を出して終了コード1で終わる
- JSON でない行を受け取ると、終了コード1で終わる
- 画像のファイルの中身と更新日時を変えない

`worker.rs`（`cargo test`。偽のワーカーは、テストが一時フォルダに書いたシェルスクリプトを `/bin/sh` で起動する）：

- ready を受け取り、要求と同じ `id` の結果を受け取れる
- 続けて3件を要求し、3件とも受け取れる
- `ok: false` は `Failure::Image` になり、次の要求を出せる
- `program` がないと `start` が `Err` になる
- `ready: false` の `error` が `start` の `Err` に入る
- ready を出さずに終わるワーカーで、`start` が `Err` になる
- ready を出さずに黙るワーカーで、`start` が `Timeouts.ready` の後に `Err` になり、プロセスが残らない
- `aspects` が `expected` と違う（モデル名、次元）と、`start` が `Err` になる
- 要求の後に終わるワーカーで、`compute` が `Failure::Dead` になる
- 返事をしないワーカーで、`compute` が `Timeouts.reply` の後に `Failure::Dead` になる
- 壊れた行、違う `id`、足りない観点、違う長さ、有限でない値（`1e39`。f32 にすると無限大になる。`NaN` は JSON として読めず「壊れた行」と同じになるので使わない）で、それぞれ `Failure::Dead` になる
- `Worker` を drop すると、プロセスが残らない

偽のワーカーの書き方：

- 黙るワーカーは `exec cat >/dev/null` と書く。`sleep` を使うと、kill されるのは `sh` だけで、`sleep` が標準出力のパイプを持ったまま残る
- pid は、偽のワーカーが最初に `echo $$ > <一時ファイル>` で残し、テストが読んで `kill -0` で確かめる（`start` が `Err` のときは `Worker` がないため）
- 返事の `id` は、`n=$((n+1))` で数えて `printf` で入れる

同梱したワーカーの確認（タスク2の完了の条件）：

タスク2の時点では、`calc` も設定もまだなく、アプリがワーカーを起動する道がありません。そこで、`cargo test` に `#[ignore]` を付けた「本物のワーカーを起動して1枚を計算する」テストを1つ置きます。開発版だけで使える仮のコマンドは作りません。

- 環境変数：`KURA_WORKER`（実行ファイル）、`KURA_MANIFEST`（`model.json`）、`KURA_MODEL_DIR`（モデルのフォルダ）。どれかがなければ、テストは理由を出して失敗する
- `expected` は `manifest::read(KURA_MANIFEST)` の `aspects`。画像は、テストが `image` クレートで一時フォルダに作る JPEG
- 確かめること：観点ごとに `dim` と同じ長さの、有限の値が返る
- リリース用ビルドの `.app` の `Contents/Resources/worker/` の `kura-worker` と `model.json` を渡し、`PATH=/usr/bin:/bin` で流す

`.app` が自分でワーカーを起動できること（`resource_dir()` からの `Spec`）と、アプリを強制終了（`kill -9`）してもワーカーが残らないことは、タスク5の実アプリの確認で確かめます（3章）。

### 決めたことと退けた案

| 決めたこと | 退けた案 | 理由 |
| --- | --- | --- |
| `std::process::Command` で起動する（2026-11-15 に利用者と決めた） | `tauri-plugin-shell`（スパイクの方式） | クレートを足さずに済む。`cargo test` で偽のワーカーを起動して、落ちたとき・黙ったときの動きを確かめられる |
| 計算する画像があるときだけ動かす（2026-11-15 に利用者と決めた） | アプリの起動中ずっと動かす | 検索はワーカーを使わない。モデル（372MB）を、作画中のメモリから外せる。起動は約0.04秒、モデルの読み込みは0.05〜0.23秒 |
| 落ちても自動では起動し直さない。落ちたときの1枚は失敗に数える（2026-11-15 に利用者と決めた） | 自動で1回だけ起動し直して続ける | 同じ画像で落ち続けるのを防ぐ決まりが1つで済む。再開は次のきっかけ（3章）で起きる |
| 要求は一度に1件 | まとめて送る、複数を並べて送る | スパイクの実測は1枚ずつ。1スレッドの推論なので、並べても速くならない。どの画像で落ちたかが必ず分かる |
| ベクトルは JSON の数値の配列 | base64 にしたバイト列 | クレートを足さずに `serde_json` で読める。1枚あたり十数KBの文字列で、読む時間は測っていない。タスク5の計測で1枚あたりの時間が推論（約48ms）より目立って長ければ報告する |
| 終わらせ方は kill だけ。ワーカーは EOF でも終わる | 終了の要求を送って待つ | ワーカーは保存する状態を持たない。終了を待たせない（5.6） |
| 開発版は `ml/.venv/bin/python -m kura_worker` | `uv run --project ml` | verify-kura は HOME を差し替えて起動する。`uv run` は差し替えた HOME にキャッシュを作ろうとして、通信するおそれがある |
| 版の食い違いは ready の `aspects` で見つける | Rust にモデル名を書いて比べる | モデルを変えても Rust を変えない（NFR-11） |

## 2. タスク4：features.db と、kura.db との食い違いの扱い

### DB の形

場所は `<ライブラリ>/.kura/features.db`。`user_version` は1。

```sql
CREATE TABLE embeddings(
    hash TEXT NOT NULL,          -- 画像の SHA-256（kura.db の images.hash と同じ値）
    aspect TEXT NOT NULL,        -- model.json の aspect
    model TEXT NOT NULL,         -- model.json の model
    vector BLOB NOT NULL,        -- float32 のリトルエンディアンを dim 個並べたもの
    computed_at INTEGER NOT NULL,-- UNIX 時間のミリ秒
    PRIMARY KEY(hash, aspect, model)
)
```

開くときの設定は `PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`。`kura.db` と違って `NORMAL` にするのは、1枚ごとのコミットで毎回ディスクへの書き出しを待たないため。電源が落ちて直前の数枚が消えても、計算し直せます。`EXCLUSIVE` は `kura.db` と同じ理由（外付けドライブが外れたときに落ちない）です。

`kura.db` には何も足しません。`MIGRATIONS` は変えません。

### Rust 側の持ち方（`features.rs`）

```rust
pub struct Store { /* Connection */ }

impl Store {
    /// 開く。無ければ作る。下の「作り直す場合」に当たれば、消して空で作る。check は「疑って開く」
    pub fn open(root: &Path, check: bool) -> Result<Store, String>;
    /// 1枚分を1つのトランザクションで書く。同じキーの行は置き換える。長さが dim と違うベクトルは、何も書かずに Err
    pub fn put(&mut self, hash: &str, vectors: &[(&Aspect, &[f32])], now: i64) -> Result<(), String>;
    /// aspects のすべてについて、今のモデル名の行がある画像のハッシュ
    pub fn computed(&self, aspects: &[Aspect]) -> Result<HashSet<String>, String>;
    /// 1つの観点の、今のモデル名の行をすべて読む（タスク6が使う）
    pub fn load(&self, aspect: &Aspect) -> Result<Vec<(String, Vec<f32>)>, String>;
    /// その画像の行を、観点とモデル名によらずすべて消す
    pub fn remove(&mut self, hash: &str) -> Result<(), String>;
    /// keep にないハッシュの行と、aspects にない（観点, モデル名）の行を消す。消した行の数を返す
    pub fn sweep(&mut self, keep: &HashSet<String>, aspects: &[Aspect]) -> Result<usize, String>;
}
```

`Library` に持たせます（`library.rs`）。

```rust
pub struct Library {
    // …今までの項目…
    features: Option<features::Store>,
    /// features.db をエラーで閉じた。次に開くときに中身を確かめる
    features_suspect: bool,
}

impl Library {
    /// 初めて使うときに開く。エラーで閉じた後は、check を付けて開き直す
    pub fn features(&mut self) -> Result<&mut features::Store, String>;
    /// f が Err を返したら、接続を捨てて features_suspect を立ててから Err を返す
    pub fn with_features<T>(&mut self, f: impl FnOnce(&mut features::Store) -> Result<T, String>) -> Result<T, String>;
    /// 画像の行を消した後に呼ぶ。features.db のファイルがなければ何もしない。失敗はログに残すだけ
    pub fn forget_features(&mut self, hash: &str);
}
```

- `features.db` を読み書きするコードは、必ず `with_features` を通す。`features()` を直接呼ぶのは `with_features` だけ
- `computed` と `sweep` は、SQL の `IN` にハッシュを並べない（2万件で変数の上限に近づく）。`SELECT` で読んで Rust の中で突き合わせ、`sweep` は消す行を1つのトランザクションで `DELETE` する
- `computed` と `load` は、`vector` の長さが `dim × 4` バイトでない行を、無いものとして扱う
- `main.rs` の `allow_assets` で、`kura.db` と同じく `features.db`、`features.db-wal`、`features.db-shm` を画面から読めないようにする
- 接続は `Library` と一緒に閉じる。ライブラリを切り替えると `Current` の中身が入れ替わるので、前のライブラリの `features.db` には書けなくなる
- 類似画像検索を使ったことのないライブラリには、`features.db` を作らない。`forget_features` はファイルがあるときだけ開く
- `reconnect`（`kura.db` の開き直し）では、`features` を `None` にし、`features_suspect` を立てる。同じドライブにあるため
- `connect` の `Library { … }` に2つの項目の初期値（`None`、`false`）を足す。`connect` を変えるので、`.claude/skills/verify-crash-safe-move/check.sh` を流す

### 作り直す場合と、作り直さない場合

`Store::open` は次の順に確かめます（2026-11-15 に利用者と決めた）。

| 順 | 確かめること | 結果 |
| --- | --- | --- |
| 1 | ファイルがない | 作る |
| 2 | 開く、上の PRAGMA を流す、`user_version` を読む。どれかが `NotADatabase` か `DatabaseCorrupt` で失敗した | 作り直す |
| 3 | 2 がほかのエラー（I/O、ロック、権限など）で失敗した | `Err` を返す。ファイルは消さない |
| 4 | `user_version` が0 | 表を作り、`user_version` を1にする（1つのトランザクション） |
| 5 | `user_version` が1でも0でもない（新しい版も含む） | 作り直す |
| 6 | `check` が true のとき、`PRAGMA quick_check` を流す。結果が `ok` でない、または `NotADatabase` か `DatabaseCorrupt` で失敗した | 作り直す |
| 7 | 6 がほかのエラーで失敗した | `Err` を返す。ファイルは消さない |

- 作り直す：接続を閉じ、`features.db`、`features.db-wal`、`features.db-shm` を消し（無いのはエラーにしない）、1 からやり直す。やり直しは1回だけで、もう一度作り直す場合に当たったら `Err` を返す。作り直したことは `log::warn!` に残す
- エラーの見分けは `rusqlite::Error::sqlite_error_code()` で行う。文言では見分けない
- 使っている途中のエラーでは消さない。外付けドライブが外れたときにも「database disk image is malformed」が出るため（7章）。`with_features` が接続を捨て、次に開くときに 6 で中身を確かめる

### kura.db との食い違い

2つの DB は別のファイルで、まとめてコミットできません。食い違いは次の決まりで吸収します。どの場合も、特徴量が別の画像に結び付くことはありません（キーが中身の SHA-256 のため）。

| 起きること | 状態 | 扱い |
| --- | --- | --- |
| 完全削除、「一覧から外す」 | 画像の行が消える | 行を消した直後に `forget_features(hash)` を呼ぶ。失敗しても操作は成功のまま（ログだけ）。残った行は次の `sweep` が消す |
| ゴミ箱へ移す、元に戻す | 画像の行は残る | 何もしない。特徴量は残る |
| 同じ場所で中身が変わった（5.1 の B） | 画像の行のハッシュが変わる | 古いハッシュで `forget_features` を呼ぶ。新しいハッシュは行がないので、未計算として計算される |
| 古い `kura.db` をバックアップから戻した | `features.db` に、`kura.db` にない画像の行がある。`kura.db` に、特徴量のない画像がある | 前者は `sweep` が消す。後者は未計算として計算される |
| `features.db` を消した、作り直した | 全部が未計算 | 計算し直される |
| アプリの更新でモデル名が変わった | 古いモデル名の行だけがある | `computed` が数えないので未計算になる。古い行は `sweep` が消す |
| 計算中に画像が完全削除された | ワーカーの結果が届いたときには行がない | `calc` が、書く直前に同じロックの中で `images` にハッシュがあるかを確かめ、なければ書かない（3章） |

`forget_features` を呼ぶ場所は、`library::remove_thumb` を呼んでいる3か所です（`trash.rs` の `purge_one`、`sync.rs` の `forget`、`sync.rs` の中身が変わった画像の古いサムネイルを消す所）。サムネイルと特徴量は、どちらも「そのハッシュの画像がなくなったら要らないもの」なので、同じ場所で消します。`remove_thumb` は `root` だけを受け取るので、`forget_features` は別の呼び出しとして足します。`sync.rs` の中身が変わった画像では、ハッシュを `UPDATE` している既存の `lib.with` のクロージャの中で、`UPDATE` の後に `l.forget_features(&old)` を呼びます（ロックが1回で済み、`forget_features` は `Result` を返さないので、差分の確認の結果を変えない）。

`sweep` を呼ぶのは `calc` の1か所だけです（3章。計算を始める前）。`keep` には、ゴミ箱と「見つからない」を含む、`images` のすべてのハッシュを渡します。

`kura.db` のバックアップ（`library::backup`）と移行前の写しは `kura.db` の接続だけを写すので、変えなくても `features.db` は入りません。テストで確かめます。

### 失敗時の動き

| 起きたこと | 動き |
| --- | --- |
| `open` が `Err`（ドライブが外れた、権限がない） | 呼んだ操作が `Err` になる。`calc` はエラーを出して止まる。ファイルは消さない |
| `put`、`computed`、`load`、`sweep` が `Err` | `with_features` が接続を捨てる。呼んだ操作が `Err` になる。次に使うときに `quick_check` 付きで開き直す |
| `forget_features` の中のエラー | ログに残して続ける。画像の操作は成功のまま |
| エラーの文が `io_failure`（`library.rs`）に当たる | 既存の動きのまま。`Access::with` が `kura.db` も開き直す。画面には「ライブラリのドライブを読めません…」が出る |

### 先に書くテスト

`features.rs`：

- 無いところに開くと `features.db` ができ、`user_version` が1になる
- `put` したベクトルを `load` で同じ値で読める（float32 のまま）
- 同じハッシュ・観点・モデル名で `put` し直すと、置き換わる
- `computed` は、すべての観点がそろった画像だけを返す
- `computed` と `load` は、モデル名の違う行を数えない
- `remove` は、その画像の行を観点とモデル名によらず消し、ほかの画像の行を残す
- `sweep` は、`keep` にないハッシュの行と、今のモデル名でない行を消し、残りを変えない
- 中身がでたらめなファイル（SQLite でない）を開くと、空で作り直す
- `user_version` が2のファイル、99のファイルを開くと、空で作り直す
- `-wal` と `-shm` が残っていても、作り直した後は空になる
- 読めないファイル（まだ開いていない `features.db` の権限を `0o000` にする。テストの終わりに戻す）を開くと `Err` になり、ファイルと中の行が残る。このとき返るエラーコードが `NotADatabase` と `DatabaseCorrupt` のどちらでもないことも確かめる
- `check` を付けて開くと、途中のページを壊したファイルを空で作り直す。`check` なしでは作り直さない。壊すときは、`Store` を drop して WAL を本体に入れてから、3ページ目より後ろを上書きする
- 長さが `dim` と違うベクトルの `put` は `Err` になり、同じ呼び出しのほかの観点も書かれない
- `computed` と `load` は、`vector` の長さが違う行を数えない
- `check` を付けて開いても、壊れていないファイルの行は残る

`library.rs`、`trash.rs`、`sync.rs`：

- ライブラリを開いただけ、取り込んだだけでは `features.db` ができない
- 完全削除すると、その画像の行が `features.db` から消える。ほかの画像の行は残る
- 「一覧から外す」と、その画像の行が消える
- ゴミ箱へ移して元に戻しても、行が残る
- 中身が変わった画像（5.1 の B）の、古いハッシュの行が消える
- `features.db` が読めない状態（ファイルの権限を `0o000` にする。`.kura` のフォルダは変えない）でも、完全削除は成功する
- `features.db` がないライブラリで完全削除しても、`features.db` ができない
- `with_features` の中で `Err` を返した後にファイルの途中のページを壊すと、次の `with_features` で空に作り直されている（`quick_check` 付きで開き直した証拠）。`Err` を返していなければ、作り直されない
- `library::backup` で書き出したファイルに `embeddings` の表がない。大きさは特徴量を入れる前と変わらない
- 特徴量を入れても `kura.db` の `user_version` が変わらない
- 特徴量のあるライブラリの `kura.db` を、特徴量を入れる前の写しに置き換えて開く。`sweep` の後、写しにない画像の行だけが消えている
- 画面から `features.db` を読めない（`main.rs` の既存のテスト「…dbとゴミ箱とライブラリの外は読めない」に足す）

実アプリ（タスク4の確認）：2万件の特徴量（乱数）を入れた `features.db` で、`PRAGMA quick_check` にかかる時間を測って報告する。`quick_check` は `Current` のロックの中で流れ、その間は一覧の読み込みなどが待つ。1秒を超えたら、作りを変えずにメインセッションに相談する

### 決めたことと退けた案

| 決めたこと | 退けた案 | 理由 |
| --- | --- | --- |
| 接続を `Library` に持たせる | Tauri の State に別の `Mutex` で持つ | ライブラリの切り替えで必ず一緒に閉じる。完全削除が、同じロックの中で両方の DB を触れる。ロックの順番を決めなくて済む |
| 初めて使うときに開く | `connect` で開く | 使わない人のライブラリに `features.db` を作らない。`connect` の手順（NFR-06 のモデル検査の対象）に処理を足さない |
| 作り直すのは、開いた時点で SQLite でない・壊れている・版が違うときだけ（2026-11-15 に利用者と決めた） | 読めなければいつでも作り直す | 外付けドライブが一瞬外れただけで、2万枚分（約17分）の特徴量を消さない |
| 作り直すときは消す | 別名で残す | 計算し直せる。約127MBの残りを利用者に片付けさせない |
| 新しい版の `features.db` も作り直す | `kura.db` と同じく、開かずにエラーにする | 古い版のアプリに戻した人を止めない。失うのは計算の時間だけ |
| 食い違いは `sweep` でまとめて消す。削除のときの `forget_features` は失敗してもよい | 2つの DB の操作を `pending_ops` でそろえる | 特徴量は計算し直せるので、画像の操作を失敗させる理由がない。`pending_ops` の手順を変えない |
| 主キーは（ハッシュ、観点、モデル名） | （ハッシュ、観点） | 5.6 の決まりのとおり。モデル名の違う行を、数えずに見分けられる |
| ベクトルは float32 の BLOB | JSON の文字列 | 2万枚で約127MBに収まる（スパイクの実測）。読み出しが速い |
| `synchronous = NORMAL` | `FULL` | 1枚ごとのコミットを軽くする。失っても計算し直せる |

## 3. タスク5：バックグラウンドの計算と、競合

### やりとりの形

Rust とワーカーのやりとりは1章のとおりで、`calc` は `worker::Worker::compute` を呼ぶだけです。

Rust と画面のやりとり：

| 名前 | 種類 | 中身 |
| --- | --- | --- |
| `features-progress` | イベント（`emit_to("main", …)`） | `Status`。状態が変わるたびに送る |
| `features_status` | コマンド | 今の `Status` を返す。画面を開いたときと、設定を開いたときに呼ぶ |
| `retry_features` | コマンド | 設定の「再計算」。失敗の記録とエラーを消して、計算を起こす |

```rust
#[derive(Clone, Default, PartialEq, Serialize)]
pub struct Status {
    /// 計算のスレッドが、未計算の画像を処理している
    pub running: bool,
    /// 対象の画像（ゴミ箱と「見つからない」を除く）のうち、計算済みの枚数
    pub done: usize,
    /// 対象の画像の枚数
    pub total: usize,
    /// 対象の未計算の画像のうち、この起動の中で計算できなかった枚数
    pub failed: usize,
    /// 計算が止まった理由。次のきっかけで計算を始めるときに消える
    pub error: Option<String>,
}
```

- ステータスバーは、`running` の間「特徴量を計算中 {done} / {total}枚」を出す。`error` があれば、状態の表示の決まり（`docs/design.md`）でエラーを出す
- 設定は、済み（`done`）、残り（`total - done - failed`）、計算できなかった枚数（`failed`）、`error`、「再計算」を出す
- 類似画像検索が OFF のとき、ライブラリを開いていないときの `Status` は、すべて初期値（`running: false`、数は0、`error: None`）
- コマンド名を足したら、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` の3か所をそろえる（`npm run lint` が確かめる）

### 状態の持ち方（`calc.rs`）

```rust
/// 計算のスレッドへの合図と、画面に見せる状態。Tauri の State に入れる
#[derive(Clone)]
pub struct Calc { /* Arc<Inner> */ }

struct Inner {
    /// ライブラリを閉じる・切り替える、OFF にするたびに1つ増やす
    generation: AtomicU64,
    /// 起こす合図。計算中に立ったら、今の回が終わった後にもう1回まわす
    wake: (Mutex<bool>, Condvar),
    status: Mutex<Status>,
    /// この起動の中で計算できなかった画像。（ライブラリのルート、ハッシュ）の組
    failed: Mutex<HashSet<(PathBuf, String)>>,
    env: Env,
}

impl Calc {
    /// スレッドを作らない。テストはこれで作って pass を直接呼ぶ
    pub fn new(env: Env) -> Calc;
    /// new して、合図を待って pass を呼ぶスレッドを1本作る。アプリの起動時に1回だけ呼ぶ
    pub fn spawn(env: Env, lib: Arc<Mutex<Option<Library>>>) -> Calc;
    /// 計算の1回分（下の手順）
    pub fn pass(&self, lib: &impl Access);
    /// 未計算の画像があるかもしれない。何度呼んでもよい
    pub fn wake(&self);
    /// 今の回を止める（generation を増やして wake する）
    pub fn halt(&self);
    /// failed と error を消して wake する（「再計算」）
    pub fn retry(&self);
    pub fn status(&self) -> Status;
}

/// 計算の1回分が外に頼るもの。テストでは偽物を渡す
pub struct Env {
    /// 類似画像検索が ON で、モデルのファイルがそろっている
    pub enabled: Box<dyn Fn() -> bool + Send + Sync>,
    pub aspects: Vec<Aspect>,
    pub start: Box<dyn Fn() -> Result<Box<dyn Compute>, String> + Send + Sync>,
    pub notify: Box<dyn Fn(&Status) + Send + Sync>,
}

pub trait Compute: Send {
    fn compute(&mut self, thumb: &Path) -> Result<Vec<Vec<f32>>, worker::Failure>;
}
impl Compute for worker::Worker { /* そのまま呼ぶ */ }
```

- スレッドは1本だけで、アプリの起動から終了まで生きる。合図がない間は `Condvar` で眠る。計算の回は必ずこのスレッドの上で動くので、2つの回が同時に動くことはない
- `Worker` は1回分の間だけ持つ。回が終わる（未計算がなくなる、止められる、失敗する）と drop して、ワーカーのプロセスを終わらせる
- ライブラリは既存の `library::Access`（`Current` の `Mutex`）を通して使う。計算のスレッドは、ロックを「計画を立てる間」と「1枚を書く間」だけ持ち、ワーカーの返事を待つ間は持たない
- 元URLの補完の門（`backfill::Gate`）は取らない。計算は画像のファイルも `kura.db` も変えないため
- `enabled` の実装（`main.rs`）は、設定の `similarity_enabled`（タスク3で足す。初期値は false）が true で、`model.json` の `file` がすべて `models/` にあること
- `library.rs` の「ライブラリを開いていません」の文を `pub const NOT_OPEN: &str` に、「ライブラリのドライブを読めません…」の文を `pub const DRIVE_UNREADABLE: &str` にし、`calc` はこの文と同じエラーを見分ける
- スレッドがライブラリを使えるように、`main.rs` の `Current` を `struct Current(Arc<Mutex<Option<Library>>>)` に変える。`current.0.with(…)` と `current.0.lock()` はそのまま動く。`&current.0` を `&impl Access` として渡している所（`sync::scan`、`import::import_paths`、`backfill` の `run` など）は `&*current.0` に直す
- `Calc::spawn` は `main.rs` の `.setup` の中で呼び、`app.manage(calc)` する（`notify` と `start` に `AppHandle` が要るため）。`.manage(Current::default())` は今のまま Builder に残し、`.setup` では `app.state::<Current>().0.clone()` を渡す
- テストの偽の `Compute` や `enabled` は、`Arc` で共有した値（呼ばれた回数、`Calc` の写し、ライブラリの `Arc`）をクロージャに持たせる

### 1回分の手順（`Calc::pass`）

1. `gen = generation` を読む。`status.error` を消す
2. `enabled()` が false なら、`Status` を初期値にして知らせ、終わる
3. ロックを取り、計画を立てる（1回の `lib.with` の中で行う）
   1. `root = lib.root`
   2. `all` = `SELECT hash FROM images`（ゴミ箱と「見つからない」を含む）
   3. `targets` = `SELECT hash FROM images WHERE deleted_at IS NULL AND missing_at IS NULL ORDER BY imported_at DESC, id DESC`
   4. `with_features` で `sweep(all, aspects)` と `computed(aspects)` を呼ぶ
   5. `pending` = `targets` のうち、`computed` にも `failed`（`root` との組で見る）にもないもの（順番は `targets` のまま）
   6. `Status` = `total: targets の数`、`failed: targets のうち computed になく failed にある数`、`done: targets のうち computed にある数`
4. 3 が `NOT_OPEN` で失敗したら、`Status` を初期値にして知らせ、終わる。ほかのエラーなら、`error` に入れて知らせ、終わる
5. `pending` が空なら、`running: false` で知らせ、終わる
6. `start()` でワーカーを起動する。失敗したら `error` に入れて知らせ、終わる。成功したら `running: true` で知らせる
7. `pending` の1枚ごとに
   1. `generation != gen` なら、ループを抜ける
   2. `compute(library::thumb_path(&root, &hash))` を呼ぶ
   3. `compute` から戻ったら、ロックを取る前に `generation != gen` を確かめ、違えばループを抜ける
   4. どの結果でも、ロックを取り（`lib.with`）、その中で「まだ有効か」を順に確かめる。`generation == gen`、`lib.root == root`、`images` にそのハッシュがある。`lib.with` が `NOT_OPEN` を返したとき、`generation` か `root` が違うときは、何も書かず、`error` にも入れずにループを抜ける。ハッシュがないだけなら、何も書かず、数えずに次の画像へ進む（`Failure::Dead` のときは 7 のとおり止まる）
   5. `Ok(vectors)` で有効なら、同じロックの中で `put` する（`aspects` と `vectors` を順に組にして渡す）。書けたら `done` を1増やす。`put` が `Err` なら `error` に入れてループを抜ける
   6. `Err(Failure::Image(e))` で有効なら、（`root`、ハッシュ）を `failed` に入れ、`status.failed` を1増やし、`log::warn!` に残す
   7. `Err(Failure::Dead(e))` なら、有効なときだけ `failed` に入れて数え、有効かどうかによらず `error` に入れてループを抜ける
   8. `Status` を知らせる
8. `Worker` を drop し、`running: false` で知らせる

スレッドの本体は「合図を待つ → 合図を下ろす → `pass` を呼ぶ」の繰り返しです。`pass` の間に合図が立っていれば、戻った後すぐにもう1回 `pass` を呼びます。取り込みの途中で足された画像は、取り込みの後の `wake` で次の回に入ります。

画面に出すエラーの文（`error`）：

| 場合 | 文 |
| --- | --- |
| ワーカーを起動できない、落ちた、返事がない、決まりと違う行 | 「特徴量の計算が止まりました。設定の「再計算」でもう一度試せます」 |
| `lib.with` が `DRIVE_UNREADABLE` を返した | その文をそのまま |
| `lib.with` がほかのエラーを返した（`features.db` や `kura.db` のエラー） | 「特徴量を保存できません。設定の「再計算」でもう一度試せます」 |

ワーカーや SQLite の元の文は、`log::error!` にだけ残します。

### きっかけ（`wake`、`halt`、`retry` を呼ぶ場所）

| 場所（`main.rs`） | 呼ぶもの | 理由 |
| --- | --- | --- |
| `release`（ライブラリを閉じる。`create_library` と `open_library` の最初） | `halt` | 前のライブラリの回を止める |
| `activate` の最後（成功したとき） | `wake` | 開いたライブラリの未計算を計算する |
| `import_paths` の最後（成功も失敗も） | `wake` | 取り込んだ画像を計算する |
| `scan_library` の最後（成功も失敗も） | `wake` | 登録した画像、中身が変わった画像を計算する |
| `with_library` の最後（成功も失敗も。`notify_board` の隣） | `wake` | ゴミ箱から戻した画像を計算する。ゴミ箱・完全削除・「一覧から外す」の後に、数を合わせ直す。未計算がなければワーカーは起動しない |
| `save_settings` で `similarity_enabled` が false → true になった | `wake` | ON にした直後に始める |
| `save_settings` で `similarity_enabled` が true → false になった | `halt` | OFF の間はワーカーを動かさない |
| `retry_features` | `retry` | 「再計算」 |

- `release` は今 `&Current` だけを受け取る。`&Calc` も受け取るように変え、呼んでいる2か所を直す
- 終了のときは何も呼ばない。プロセスが終わると標準入力が閉じ、ワーカーは自分で終わる（1章）。書きかけの `put` は SQLite のトランザクションが取り消す
- `save_settings` では、`save_and_apply` の `apply` の中で前後の `similarity_enabled` を控えるだけにし、`save_and_apply` が `Ok` を返した後に `wake` か `halt` を呼ぶ。`apply` が失敗して設定を前の値に戻したときに、合図だけが届かないようにするため
- タスク3は、モデルのファイルを置き終えてから `similarity_enabled` を true で保存する。順番が逆だと、`wake` の時点で `enabled()` が false になり、計算が始まらない
- 画面からは `wake` を呼ばない。きっかけはすべて Rust の中にある

### 競合ごとの動き

| 競合 | 動き |
| --- | --- |
| 計算中にライブラリを切り替える | `release` が `halt` を呼び、`Current` のロックを待つ（長くても1枚を書く時間）。計算のスレッドは、ワーカーの返事を受け取った後、`generation` が変わっているので書かずに抜け、ワーカーを終わらせる。`activate` の `wake` で、次のライブラリの計画を立てて始める。待つ時間は長くても1枚の計算（約50ms） |
| 計算中に同じライブラリを開き直す | 上と同じ。`root` は同じでも `generation` が違うので、古い回は書かない |
| 計算中に終了する | 待たない。ワーカーは EOF で終わる。計算済みの分は `features.db` に残り、次に開くと `computed` に入るので、続きから計算する |
| 計算中に OFF にする | `halt`。次の `pass` は `enabled()` が false なので、`Status` を初期値にして終わる。計算済みの特徴量とモデルは残る |
| 計算中に ON→OFF→ON と続けて切り替える | `halt` と `wake` が続けて届く。古い回は抜け、次の回が1回だけ動く（合図は旗1つなので、重なっても1回） |
| 計算中に取り込み・差分の確認・ファイル操作・ボードの保存をする | どれも `Current` のロックを、1枚を書く間（数ms）だけ待つ。計算のスレッドは補完の門を取らないので、互いに止め合わない |
| 計算中に画像をゴミ箱へ移す | そのまま計算して保存する（特徴量はゴミ箱の画像にも残す決まり） |
| 計算中に画像を完全削除する、「一覧から外す」 | 書く直前に `images` にハッシュがないので、書かない。サムネイルが先に消えていれば `Failure::Image` になるが、同じ確かめで `failed` にも入れない。操作の後の `wake` で、数を合わせ直す |
| 計算中にライブラリを閉じる（切り替えの途中） | `release` が `Current` を空にした後にロックを取ると、`lib.with` は `NOT_OPEN` を返す。エラーにせずに抜ける |
| 計算中に、同じ場所で中身が変わる（5.1 の B） | 古いハッシュは上と同じ。新しいハッシュは、差分の確認の後の `wake` で次の回に入る |
| 計算中に「再計算」を押す | `failed` を消して合図を立てる。今の回は続き、終わった後の次の回で、失敗していた画像をもう一度計算する |
| 計算が止まっている（`error` がある）ときに、取り込みなどのきっかけが来る | 新しい回を始める。`error` は消える。落ちたときの1枚は `failed` に入っているので、同じ画像では落ちない |
| ライブラリを開いていないときに ON にする | `NOT_OPEN` なので何もしない。開いたときの `wake` で始まる |
| 外付けドライブが外れる | `put` か計画が `Err` になり、`error` を出して止まる。つなぎ直した後の次のきっかけで、`quick_check` を通して開き直して続ける |

### 先に書くテスト

`calc.rs`（`pass` を直接呼ぶ。ライブラリは一時フォルダに作り、`Compute` は偽物を渡す。スレッドを使うのは最後の2つだけ）：

- 未計算の画像を、取り込み日の新しい順に計算し、1枚ごとに保存する
- ゴミ箱の画像と「見つからない」画像を計算しない
- 計算済みの画像を計算し直さない（途中で止めた後の続き）
- `enabled` が false なら、ワーカーを起動せず、`Status` が初期値になる
- 未計算がなければ、ワーカーを起動しない
- ライブラリを開いていなければ、エラーにせず、`Status` が初期値になる
- 計算の途中でライブラリが閉じられると、`error` を入れずに抜ける（偽の `Compute` の中で `halt` を呼び、`Current` を `None` にする）
- モデル名の違う行しかない画像を計算し直し、古い行が消える
- `kura.db` にない画像の行が、計算を始める前に消える
- `Failure::Image` の画像を `failed` に数え、次の画像へ進む。同じ `Calc` で `pass` をもう一度呼んでも、その画像を計算しない
- `retry` の後の `pass` は、失敗していた画像をもう一度計算する
- `Failure::Dead` で、その画像を `failed` に数え、`error` を入れて止まる。残りの画像を計算しない。次の `pass` は、その画像を飛ばして残りを計算する
- ワーカーを起動できないと、`error` を入れて止まり、どの画像も `failed` に数えない
- 計算の途中で `generation` が変わると、その画像を書かずに抜ける（偽の `Compute` の中で `halt` を呼ぶ）
- 計算の途中でライブラリが入れ替わると、前のライブラリの結果を、次のライブラリの `features.db` に書かない（偽の `Compute` の中で `Current` を別のライブラリに入れ替える）
- 計算の途中で完全削除された画像を書かない。偽の `Compute` が `Failure::Image` を返しても、`failed` に数えない
- あるライブラリで `failed` に入った画像と同じハッシュの画像を、別のライブラリでは計算する
- 計算の途中でゴミ箱へ移された画像は保存する
- `put` が失敗すると、`error` を入れて止まる（偽の `Compute` に、長さが `dim` と違うベクトルを返させる）
- `Status` が1枚ごとに合っている。`done` は `features.db` の `computed` の数、`failed` は `failed` に入った対象の画像の数、`total` は対象の画像の数と一致する
- `features.db` のエラーの文は言い換え、`DRIVE_UNREADABLE` はそのまま `error` に入る
- 回が終わると、`Compute` が drop される（偽物の `Drop` で確かめる）
- スレッド：`wake` で計算が始まり、終わると `running` が false になる
- スレッド：計算の途中の `wake` は、今の回の後にもう1回まわす（途中で足した画像が計算される）

`main.rs` のきっかけは、実アプリ（verify-kura）で確かめます。

- リリース用ビルドの `.app` を `PATH=/usr/bin:/bin` で起動し、ON にすると計算が始まり、ステータスバーの数が進む（`resource_dir()` からのワーカーの起動）。OFF にすると、ワーカーのプロセスがいなくなる
- 計算中にアプリを強制終了（`kill -9`）すると、ワーカーのプロセスが残らない
- 未計算のままゴミ箱へ移した画像を元に戻すと、計算される
- 計算中に、取り込み・差分の確認・カテゴリの移動・ゴミ箱・ボードの保存ができる
- 計算中にライブラリを切り替えると、次のライブラリの計算が始まる。2つの `features.db` の行が、それぞれの `kura.db` のハッシュだけになっている
- 計算中に終了すると、すぐ終わり、ワーカーのプロセスが残らない。開き直すと続きから計算する
- 計算中にワーカーを `kill` すると、エラーが出て止まる。「再計算」で続きが計算され、落ちたときの1枚だけが失敗に残る
- 2万枚のダミーのライブラリで、計算中のスクロールを測る（NFR-01）。測った値と1枚あたりの時間を報告する

### 決めたことと退けた案

| 決めたこと | 退けた案 | 理由 |
| --- | --- | --- |
| 計算のスレッドは1本で、合図で起こす | きっかけごとに `spawn_blocking` する | 2つの回が同時に動かないことを、作りで保証する。ワーカーも1つで済む |
| 止める合図は `generation` の数 | 止める旗（`AtomicBool`） | 旗は、止めた直後に始める（切り替え、OFF→ON）と、古い回が止まる前に下ろされる。数なら、古い回は必ず自分が古いと分かる |
| 書く直前に、同じロックの中で `generation`・`root`・ハッシュを確かめる | ワーカーの返事を待つ間もロックを持つ | 取り込み・ファイル操作・切り替えを、1枚の計算（約50ms）のたびに待たせない |
| 計画は回の最初に1回立てる。足された画像は次の回で拾う | 1枚ごとに未計算を問い合わせる | 2万枚で、問い合わせを2万回しない |
| 失敗した画像はメモリの中だけに持つ（2026-11-15 に利用者と決めた） | `features.db` に失敗の行を書く | 起動し直せばもう一度試せる。DB の版を上げずに済む |
| 「再計算」は、失敗と未計算をもう一度計算するだけ（2026-11-15 に利用者と決めた） | 今のライブラリの特徴量を全部消して計算し直す | 止まった計算を再開するきっかけを兼ねる。全部を計算し直すには `features.db` を消す |
| 終了のときは何もしない | 終了の前に `halt` して、スレッドの終わりを待つ | 終了を待たせない（5.6）。ワーカーは EOF で終わり、書きかけは SQLite が取り消す |
| 補完の門（`backfill::Gate`）を取らない | 取り込みなどと同じく読み取り側を取る | 計算はファイルも `kura.db` も変えない。門を取ると、計算中は元URLの補完を始められなくなる |
| 進み具合は1枚ごとに送る | 一定の時間ごとにまとめる | 取り込みと差分の確認が1枚ごとに送っていて、問題が出ていない。1枚に約50msかかるので、多くても毎秒20回 |
| ワーカーは回ごとに起動する | ON の間は動かしたままにする | 1章の「計算する画像があるときだけ動かす」のとおり |
| `sweep` は回の最初に毎回呼ぶ | ライブラリを開いたときだけ呼ぶ | 呼ぶ場所が1つで済む。2万枚での時間は測っていないので、タスク5の2万枚の計測で、計画を立てる時間も測って報告する |

## 4. 3b への覚え書き

3b（ポーズ）で作り直す所です。3a では決めません。

- ワーカーのやりとりは「1枚で全部の観点を返す」、`computed` は「全部の観点がそろった画像」です。ポーズをこの形のまま足すと、3a で計算済みの画像の内容と構図も計算し直すことになり、phase3.md のタスク13の「内容と構図の特徴量を計算し直さない」と合いません。要求に観点を指定する形にするか、タスク12で決めます
- 人物を検出できなかった画像の記録（計算をやり直さない）は、`embeddings` の行では表せません。持ち方はタスク12で決めます
