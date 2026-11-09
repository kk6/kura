# フェーズ2のまとまりとブリーフ

2026-11-08 作成、2026-11-09 にまとまりへまとめ直した。実装開始時に使う依頼案です。

## まとまり

[phase2.md](phase2.md) のタスク（#0〜#21）を、1回のセッションで頼める大きさのまとまりにまとめています。同じ画面や同じ仕組みに触れる隣り合うタスクを1つにしました。表の順に、前のまとまりをメインセッションで確認・統合してから次へ進みます。共有するDB・保存・ウィンドウの変更が多いため、並行して進める前提にはしません。

| まとまり | タスク | 内容 | ブランチ |
| --- | --- | --- | --- |
| A | 0、1 | ネイティブ機能の確認、DBと保存API（済） | `feat/phase2-idea-board` |
| B | 2、3 | ON/OFF・入口・専用ウィンドウ、ボードの作成・切り替え・名前・削除 | `feat/phase2-board-window` |
| C | 4 | ギャラリーからボードに追加 | `feat/phase2-board-add` |
| D | 5 | 自動保存・切り替え・終了の保存待ち | `feat/phase2-save-lifecycle` |
| E | 6、7 | 選択・移動・拡縮・配置削除、パン・ズーム・視点の保存 | `feat/phase2-board-canvas` |
| F | 8 | 重なり順、取り消し・やり直し | `feat/phase2-board-history` |
| G | 9、10 | 反転・回転・グレースケール、トリミング | `feat/phase2-board-transforms` |
| H | 11 | 最前面・不透明度・位置と大きさ | `feat/phase2-window-display` |
| I | 12 | 元画像の状態とギャラリーとの連携 | `feat/phase2-image-lifecycle` |
| J | 13、14 | 元URLの取得と、ブラウザで開くリンク | `feat/phase2-source-url` |
| K | 15、16 | 元URLの手動補完、見つからないライブラリを一覧から外す | `feat/phase2-backfill-recent` |
| L | 17、18 | メニュー・入力・ウィンドウ間の操作、性能・バックアップ・2ライブラリの通しの検証 | `feat/phase2-integration` |
| M | 19、20 | 実アプリの検証手順、利用者向け文書とリリース準備 | `feat/phase2-release-prep` |

まとめ方の理由：

- B：専用ウィンドウを開く処理と、その上部のボード管理は同じ画面で、どちらもタスク1の保存APIを初めて画面へつなぐ
- E：範囲選択とパンはどちらも空白でのドラッグを使うので、衝突しないように1度に作る
- G：トリミングは回転・反転と組み合わせて確かめるので、加工と一緒に作る
- J：取り込みで読んだ元URLを詳細パネルに出すまでを1度に確かめられる
- K：どちらも小さく、ボードの画面に触れない。一緒にしても互いの変更が重ならない
- L、M：どちらも、作った機能を通して確かめる作業と文書の作業で、新しい機能を足さない
- C、D、F、H、I はそれぞれ1つで1回分の大きさがあるので、まとめない

各まとまりのブランチは `feat/phase2-idea-board` の最新から切り、終わったら `feat/phase2-idea-board` へマージします。main には、フェーズ2の完了の確認（タスク21）が済んでから入れます。main にフェーズ2の途中の DB 移行を入れないためです（2026-11-09 に利用者と決めた）。

タスク21は利用者とメインセッションで行います。まとまりが大きすぎると分かったら、未検証の部分を隠さず報告してから、次の依頼をさらに分けます。各ブランチは途中段階であり、フェーズ2全体の完成を意味しません。

## 貼り付ける共通ブリーフ

`<記号>`、`<番号>`、`<ブランチ>` を上の表から埋め、必要なら前のまとまりの報告と統合済みコミットを添えます。

```text
Kura のフェーズ2、docs/tasks/phase2-sessions.md のまとまり <記号>（docs/tasks/phase2.md のタスク <番号>）を担当してください。

最初に ls ~/.claude/plugins/cache/cursor-plugins/pstack/ でインストール済みの版を確認し、
~/.claude/plugins/cache/cursor-plugins/pstack/<版>/skills/poteto-mode/SKILL.md を全部読んでください。
サブセッションでは /poteto-mode は自動で読み込まれません。
2026-11-08 の確認では最新のインストール済み版は 0.15.36 でした。開始時に再確認してください。

続いて CLAUDE.md、docs/requirements.md の該当節、docs/design.md、docs/development.md、
docs/tasks/phase2.md、docs/tasks/phase2-check.md、このブリーフを読んでください。
docs/future-ideas.md は将来の検討材料です。作品管理・見本誌の実装や共通基盤は範囲外です。

最初に git status と現在のブランチを確認し、feat/phase2-idea-board の最新を基点に
ブランチ <ブランチ> で対象のタスクだけを進めてください。
既存の変更を捨てず、無関係な変更を含めないでください。
仕様は要件定義書の確定内容に従い、未決事項を実装で決めないでください。
必要な変更、対応する検証、利用者向け文書の更新まで行い、結果を報告して止まってください。
区切りごとにコミットし、各コミットでテストが通る状態にしてください。コミットメッセージには対象のIDを入れてください。

サブセッションはマージも push もしません。タグの作成・pushやリリースも行いません。
頼まれても「マージと push はメインセッションに任せます」と答え、報告して止まってください。
メインセッションがブランチと差分、CI相当のローカル検査、利用者の実アプリ確認を経て、
利用者の許可を得てマージし、push後のCIを確認します。

本物の資料フォルダ ~/Pictures/References には触れません。読み取りもしません。
開発・検証は生成したダミー画像と隔離した設定・履歴で行ってください。
画像は docs/images/ のスクリーンショット以外コミットしません。

Rustのファイル操作はテストを先に書き、失敗時もテストしてください。
書き込み失敗は src-tauri/src/category.rs のlock/unlock方式を使ってください。
exFAT/FAT32はUnix権限を持たないため、chmodだけで失敗を作らないでください。
フォルダ名はNFCにそろえて比較してください。
コードのコメントは、ほかのファイルと同じく日本語で書いてください（ライセンス文などの引用は除く）。

e2e（Playwright＋モック）はRust、メニューバー、ネイティブダイアログ、
別ウィンドウ、最前面表示、不透明度を検証できません。
RustコマンドやDBを変えたら .claude/skills/verify-kura/SKILL.md を読み、
実アプリを隔離して操作し、画面・DB・ファイル・ログの証跡を残してください。
fileops.rs、library.rs のconnect/apply_op、pending_opsに触れたら
.claude/skills/verify-crash-safe-move/check.sh を実行してください。
DRIFTが出たら、そのSKILL.mdに従ってモデルを合わせてください。
マージ前には利用者が実アプリで確認します。未確認を合格扱いにしないでください。

e2eはポート5173を使います。利用者の npm run tauri dev と競合させず、
既存プロセスを勝手に止めないでください。
npm run tauri dev はRustを最適化しないため画像処理が遅くなります。
NFR-04などの性能確認は npm run tauri build のリリース用ビルドで行ってください。
ruffは uvx ruff@0.17.3（ruff.tomlの固定版）を使ってください。
lefthookはコミット時に整形・検査を実行します。

画面の動作や文言を変えたら同じタスクで docs/user-guide.md も直してください。
必要なら npm run docs:screenshots で docs/images/ を撮り直してください。
リリース準備は CHANGELOG.md と npm run version:set -- <版> を使います。
タグをpushすると release.yml がGitHub Releaseを作るため、サブセッションでは実行しません。

報告には、ブランチ・基点・変更（コミットした場合はコミットID）、対象タスクと要件ID、
検査コマンドと結果、実アプリの証跡の場所、phase2-checkの対応項目、
利用者が確かめる操作、未確認・制約・残る課題を含めてください。
```

## メインセッションの統合手順

1. 報告を受けたら、`git status`、現在のブランチ、基点からの差分とコミットを確認する。対象タスク以外の変更や、未保存の利用者の変更を混ぜない
2. `.github/workflows/ci.yml` を読んで、変更に対応するCIと同じコマンドを手元で実行する。2026-11-08時点ではwebは `npm run lint`、`npm test`、`npm run build`。e2eは `npm run test:e2e`。Rustは画面ビルド後に `src-tauri/` で `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`。Python変更時は `uv run --with pillow --with pytest pytest scripts/`、`uvx ruff@0.17.3 check`、`uvx ruff@0.17.3 format --check`。実行時のCI定義を正本にする
3. 実アプリの証跡を確認し、利用者が [phase2-check.md](phase2-check.md) の該当箇所を実アプリで確かめる。ネイティブ機能をモックの合格だけで済ませない
4. 検査結果と具体的な差分を示し、利用者の許可を得て `feat/phase2-idea-board` へマージする。サブセッション側ではマージしない
5. `feat/phase2-idea-board` をpushして対象コミットのCIを確認する。失敗は解消してから次のまとまりへ進む。リリースのタグpushは通常の統合とは別に扱う
