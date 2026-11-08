# フェーズ2のサブセッション分割とブリーフ

2026-11-08 作成。実装開始時に使う依頼案です。この文書の作成ではセッションやブランチを作っていません。

## 分割案

[phase2.md](phase2.md) の1行を1サブセッションにします。表の順に、前のまとまりをメインセッションで確認・統合してから次へ進みます。共有するDB・保存・ウインドウの変更が多いため、独立した実装を並行させる前提にはしません。

| タスク | まとまり | ブランチ |
| --- | --- | --- |
| 0 | ネイティブ機能と保存待ちの実証 | `feature/phase2-native-check` |
| 1 | DBと保存API | `feature/phase2-board-data` |
| 2 | ON/OFF・入口・専用ウインドウ | `feature/phase2-board-window` |
| 3 | ボードの作成・切り替え・名前・削除 | `feature/phase2-board-management` |
| 4 | ギャラリーから追加 | `feature/phase2-board-add` |
| 5 | 自動保存・切り替え・終了 | `feature/phase2-save-lifecycle` |
| 6 | 選択・移動・拡縮・配置削除 | `feature/phase2-board-selection` |
| 7 | パン・ズーム・視点保存 | `feature/phase2-board-viewport` |
| 8 | 重なり順・Undo/Redo | `feature/phase2-board-history` |
| 9 | 反転・回転・グレースケール | `feature/phase2-board-transforms` |
| 10 | トリミング | `feature/phase2-board-crop` |
| 11 | 最前面・不透明度・位置と大きさ | `feature/phase2-window-display` |
| 12 | 元画像の状態とギャラリー連携 | `feature/phase2-image-lifecycle` |
| 13 | 元URLの取得 | `feature/phase2-source-metadata` |
| 14 | 元URLをブラウザで開く | `feature/phase2-source-link` |
| 15 | 元URLの手動補完 | `feature/phase2-source-backfill` |
| 16 | 見つからないライブラリの履歴削除 | `feature/phase2-recent-libraries` |
| 17 | メニュー・入力・ウインドウ間の操作確認 | `feature/phase2-menu-integration` |
| 18 | 性能・バックアップ・2ライブラリの検証 | `feature/phase2-integration-check` |
| 19 | 実アプリの検証手順の整備 | `feature/phase2-verification-guide` |
| 20 | 利用者向け文書とリリース準備 | `feature/phase2-release-prep` |

タスク21は利用者とメインセッションで行います。完了条件が大きすぎると分かったタスクは、未検証部分を隠さず報告してから、次の依頼をさらに分けます。各ブランチは途中段階であり、フェーズ2全体の完成を意味しません。

## 貼り付ける共通ブリーフ

`<番号>` と `<ブランチ>` を上の表から埋め、必要なら前のまとまりの報告と統合済みコミットを添えます。

```text
Kura のフェーズ2、docs/tasks/phase2.md のタスク <番号> を担当してください。

最初に ls ~/.claude/plugins/cache/cursor-plugins/pstack/ でインストール済みの版を確認し、
~/.claude/plugins/cache/cursor-plugins/pstack/<版>/skills/poteto-mode/SKILL.md を全部読んでください。
サブセッションでは /poteto-mode は自動で読み込まれません。
2026-11-08 の確認では最新のインストール済み版は 0.15.36 でした。開始時に再確認してください。

続いて CLAUDE.md、docs/requirements.md の該当節、docs/design.md、docs/development.md、
docs/tasks/phase2.md、docs/tasks/phase2-check.md、このブリーフを読んでください。
docs/future-ideas.md は将来の検討材料です。作品管理・見本誌の実装や共通基盤は範囲外です。

最初に git status と現在のブランチを確認し、指定された統合済みの状態を基点に
ブランチ <ブランチ> で対象タスクだけを進めてください。
既存の変更を捨てず、無関係な変更を含めないでください。
仕様は要件定義書の確定内容に従い、未決事項を実装で決めないでください。
必要な変更、対応する検証、利用者向け文書の更新まで行い、結果を報告して止まってください。
コミットの要否は依頼に明示された範囲に従い、作る場合は対象IDをメッセージに入れてください。

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

e2e（Playwright＋モック）はRust、メニューバー、ネイティブダイアログ、
別ウインドウ、最前面表示、不透明度を検証できません。
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
4. 検査結果と具体的な差分を示し、利用者の許可を得てマージする。サブセッション側ではマージしない
5. pushして対象コミットのCIを確認する。失敗は解消してから次のまとまりへ進む。リリースのタグpushは通常の統合とは別に扱う
