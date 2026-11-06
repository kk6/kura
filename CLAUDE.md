# Kura

イラスト制作用の参考画像を、ローカルで取り込み・整理・検索し、作画中に参照するための個人用 macOS デスクトップアプリ。

## まず読むもの

- `docs/requirements.md`：要件定義書。機能要件には FR-xxx、非機能要件には NFR-xx の ID が付いている
- `docs/design.md`：デザインの決まり。画面に手を入れる前に必ず読む
- `docs/user-guide.md`：利用者向けの使い方。画面の動きや文言を変えたら合わせて直す

要件定義書の「未決事項」に関わる判断が必要になったら、実装で決めずに質問する。決まったことは `docs/requirements.md` に書き戻す。

## 技術構成

- アプリ基盤：Tauri 2
- 画面：React + TypeScript
- OS に関わる処理（ファイル操作、DB、サムネイル生成、URL からのダウンロード）：Rust
- データ保存：SQLite（ライブラリ内の `.kura/` に置く）
- 機械学習（骨格推定、画像埋め込み、構図の特徴量）：Python の別プロセス。環境管理は uv。配布時は PyInstaller の onedir の形で `.app` に同梱する（`docs/requirements.md` の4章）

想定するディレクトリ構成：

```
src/          React（画面）
src-tauri/    Rust（Tauri 本体）
ml/           Python（特徴量の計算）
docs/         要件定義書、デザインの決まり
scripts/      開発用スクリプト（ダミーライブラリの生成など）
spikes/       使い捨てのプロトタイプ。結果は各 README と要件定義書の4章にある。本体のコードから参照しない
```

## コマンド

初回は `npm install` と `npx playwright install webkit` を実行する。`npm install` はコミット前のフック（lefthook）も入れる。フックはコミットするファイルだけを Prettier、ESLint、rustfmt、ruff にかける。`git blame` で整形だけのコミットを飛ばすには `git config blame.ignoreRevsFile .git-blame-ignore-revs` を実行する。

- 開発サーバー（アプリ）：`npm run tauri dev`
- 開発サーバー（Tauri のコマンドをモックに差し替えた画面だけ）：`npm run dev:mock`（http://localhost:5173）。モックの応答は `src/mocks/ipc.ts` に書く
- ダミーライブラリの生成：`npm run dev-library -- <枚数>`（`dev-library/` に出力。空でないと止まる）
- テスト（Rust）：`cargo test`（`src-tauri/` で実行）
- テスト（Rust、別のファイルシステム）：`hdiutil create -size 64m -fs ExFAT -volname KURAEX <名前>.dmg` で作ったイメージを `hdiutil attach -nobrowse` でマウントし、`KURA_TEST_DIR=<マウント先> cargo test fileops` で同じテストを流す（HFS+ や大文字・小文字を区別する APFS も同じ）
- テスト（画面の単体テスト）：`npm test`（Vitest。`src/**/*.test.ts` を流す）
- テスト（画面）：`npm run test:e2e`（モックの開発サーバーを Playwright の WebKit で開き、`test-results/` にスクリーンショット（`gallery.png` など）を保存する）
- ドキュメントのスクリーンショット：`npm run docs:screenshots`（モックの開発サーバーを Playwright の WebKit で開き、`docs/images/` に撮り直す。`e2e/docs-screenshots.ts`。CI では流さない）
- テスト（Python）：`uv run pytest`（`ml/` で実行）
- テスト（scripts/）：`uv run --with pillow --with pytest pytest scripts/`
- 整形（TypeScript と設定ファイル）：`npm run format`（Prettier）
- 整形（Rust）：`cargo fmt`（`src-tauri/` で実行）
- 整形（Python）：`uvx ruff@0.17.3 format`
- Lint（TypeScript）：`npm run lint`（型検査、ESLint、Prettier の整形の確認、トークン以外の値の検出、ドキュメントの食い違いの検出）。ドキュメントの検査（`scripts/check-docs.mjs`）は、`docs/design.md` のトークンの表と `tokens.css` の名前と値、この CLAUDE.md と README.md の `npm run` のコマンドが `package.json` にあるか、Tauri のコマンド名が `main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` で揃っているかを確かめる。アプリのバージョンが `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` とロックファイルで揃っているかも確かめる
- Lint（Rust）：`cargo fmt --check` と `cargo clippy -- -D warnings`（`src-tauri/` で実行）
- Lint（Python）：`uvx ruff@0.17.3 check` と `uvx ruff@0.17.3 format --check`（`spikes/` は対象外）
- CI：`.github/workflows/ci.yml`。push と pull request で、上のテストと Lint を流す。ジョブは web（lint、Vitest、build）、e2e、rust、python に分かれて並列に動く。e2e と rust は macOS、OS に左右されない web と python は ubuntu で流す。web はいつも流れ、ほかの3つは `changes` ジョブ（dorny/paths-filter）が変わったファイルを見て流すかを決める（`ml/` の pytest は `ml/` ができてから足す）
- リリース：(1) `npm run version:set -- <版>` で `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` とロックファイルのバージョンをそろえる (2) `CHANGELOG.md` に `## [<版>] - <日付>` の項を書く (3) コミットして `main` に入れる (4) `git tag v<版>` を push する。`.github/workflows/release.yml` が、タグとバージョンと CHANGELOG の項を確かめてから `.app` を `Kura-<版>-arm64.zip` にし、CHANGELOG の項を説明にした GitHub Release を作る。`.app` は署名も公証もしない（`tauri.conf.json` のアドホック署名だけ）

## 設計上の決まり

- ライブラリ（画像ファイルと `.kura/`）に書き込むのは Rust だけにする。Python は画像を読んで特徴量を返すだけで、ファイルも DB も変更しない。
- 画像ファイルは削除しない。削除操作ではアプリ内のゴミ箱（`.kura/` 配下）に移す。完全に消すのは、利用者がゴミ箱を空にしたときだけ。
- 画像の元ファイルの中身は変更しない。反転・回転・グレースケールは表示上の状態として DB に保存する。
- ファイルの移動や名前変更は、途中で失敗しても画像が失われない手順で行う。DB とファイルの不整合は検出できるようにする（NFR-06）。手順は「予定を `pending_ops` に記録 → 上書きしない rename → DB 更新」の3段階（`docs/requirements.md` の4章）。
- 外部への通信は、URL からの取り込みと、初回のモデルのダウンロードだけにする（NFR-08）。
- Rust 本体では println! を使わず、ログはログ用のクレートで出す。
- spikes/ は参考用で、本体から import しない。

## 画面の決まり

- 色・文字サイズ・余白は `src/styles/tokens.css` の CSS 変数だけを使う。値を直接書かない。
- 白・黒・グレー以外の色、グラデーション、影、絵文字アイコンは使わない。例外は、エラー・警告・完了・お知らせを示す4色（`docs/design.md` の「状態の表示」）と、画像から計算した色（代表色の塗りつぶし、主要な8色の見本。`docs/design.md` の「画像の中身の色」）だけ。詳細は `docs/design.md` の「使わないもの」。
- 画面を変えたら、Tauri のコマンドをモックに差し替えた開発サーバーを Playwright で開き、スクリーンショットで見た目を確認する。

## テストとデータの扱い

- 本物の資料フォルダには絶対に触れない。読み取りもしない。
- 開発とテストには、`scripts/` のスクリプトで生成したダミー画像のライブラリを使う。
- 画像ファイルをリポジトリにコミットしない。テスト用の画像も、テストの中で生成する。
  - 例外は `docs/images/` のスクリーンショットだけ。README とユーザーガイドに載せる。中身は、ダミーのデータをモックの画面（`npm run dev:mock`）に出して `npm run docs:screenshots` で撮ったもの。本物の資料を写さない。1枚 300KB 以下を目安にする
- Rust のファイル操作は、テストを先に書いてから実装する。失敗時の動き（移動の途中で失敗した場合など）もテストする。

## 作業の進め方

- 1つの作業は、FR-xxx の ID 1つか、関連する数個の ID の単位にする。
- コミットメッセージや PR の説明には、対応した ID を書く。
- フェーズの順番は `docs/requirements.md` の「開発フェーズと優先度」に従う。
