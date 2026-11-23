# フェーズ4 のまとまりとブリーフ

進行役のセッションが、まとまりごとに作業セッションを始めるときに渡すブリーフです。新しい範囲を上に足します。

## 4b

2026-11-23 作成。タスク11（未決事項を決める）は #66 で済ませました。FR-606 の置き場所、FR-608 の落とし先、FR-109 で登録しなかったファイルの移し先は、このまとまりを書くときに利用者と決め、要件定義書に書き戻しました。

### まとまり

[phase4.md](phase4.md) のタスク12〜18を、1回のセッションで頼める大きさに分けています。タスク13は、しきい値を測る前半（B）と、組を探す後半（D）に分けています。タスク19は利用者の確認です。

| まとまり | タスク | 内容 | 前提 | 並行 | ブランチ |
| --- | --- | --- | --- | --- | --- |
| A | 12 | 類似画像検索の結果から1枚にまとめる（FR-610）（完了：#67、2026-11-23） | タスク11 | B と並行できる | `feat/fr-610-merge` |
| B | 13 の前半 | 元が同じ画像のしきい値を実測する（FR-611、NFR-03）（完了：#68、2026-11-23。0.90 と、名前が写しの形の2枚に 0.85） | タスク11 | A と並行できる | `feat/fr-611-threshold` |
| C | 13b、13c | 差分検出で登録しなかった重複の整理と、未対応のファイルを移す（FR-109、FR-108） | A | しない | `feat/fr-108-109-skipped` |
| D | 13 の後半、17 | ライブラリ全体から元が同じ画像の組を探す。メニューバーの項目と ⇧⌘F（FR-611、6章、NFR-12） | B、C | しない | `feat/fr-611-find-groups` |
| E | 14 | 拡大表示に骨格を重ねる（FR-606） | D | しない | `feat/fr-606-pose-overlay` |
| F | 16 | 「画像で探す」にドロップして似た画像を探す（FR-608） | E | しない | `feat/fr-608-search-by-image` |
| G | 18 | 検証手順、文書、リリース準備 | F | しない | `chore/4b-release-prep` |

分け方の理由：

- A、C、D、E、F はどれも Tauri のコマンドを足すので、`main.rs` と `src/mocks/ipc.ts` に触れる。そのため互いに並行にしない
- B は `scripts/` に変形した組を作るスクリプトを足し、測った値を要件定義書の4章に書くだけで、`main.rs`、`src/mocks/ipc.ts`、`src/`、`src-tauri/` に触れない。A と並行できる
- タスク13の後半（D）は、A の「1枚にまとめる…」のダイアログと、B で決まるしきい値を使う。しきい値は利用者が B の PR で確かめてから使う
- タスク17の「元が同じ画像の組を探す…」はタスク13の後半の入口なので、D に入れる。「似た画像を探す」（⇧⌘F）も同じ `menu.rs` の箇所に足すので、一緒に作る
- C は D の前に置く。B の結果を利用者が確かめている間に進められるため
- G は作った機能を通して確かめる作業と文書の作業で、新しい機能を足さない

各まとまりは main から切り、終わったら main へマージします。

### ブリーフ

#### A

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり A、タスク12（FR-610）を担当する。類似画像検索の結果で、元が同じ画像（大きさ、トリミング、色味が違う同じ写真）を2枚以上選び、1枚を残してほかをゴミ箱に移す「1枚にまとめる…」を作る。細部は 2026-11-23 に利用者と決め、要件定義書と ADR-0033 に書いてある。

まとまり B（しきい値の実測。`scripts/` と要件定義書の4章だけに触れる）が別のセッションで同時に進む。後のまとまり D（ライブラリ全体から組を探す）は、ここで作るダイアログをそのまま使う。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の5.6 の「元が同じ画像の整理（FR-610、FR-611。フェーズ4b）」の「類似画像検索の結果から（FR-610）」、5.6 の「入口と結果」、FR-511（ゴミ箱）
- `docs/adr/0033-merge-same-origin-images.md`
- `GLOSSARY.md` の「元が同じ画像」「組」「1枚にまとめる」
- `docs/design.md`
- `docs/tasks/phase4.md` のタスク12、`docs/tasks/phase4-check.md` の B の該当項目
- `src-tauri/src/trash.rs`（`trash`）、`src-tauri/src/board.rs`（`board_items`、`board_sources`、`crop`）、`src-tauri/src/tag.rs`、`src-tauri/src/source.rs`、`src-tauri/src/library.rs` の `apply_op`
- `src/contextMenu.ts`（`imageMenu`）、`src/Detail.tsx`（複数選択の詳細パネル）、`src/MoveCategoryDialog.tsx`（FR-416 のダイアログ。`CategorySelect` の使い方）
- `.claude/skills/verify-kura/SKILL.md`、`.claude/skills/verify-crash-safe-move/SKILL.md`

## 注意すること

- ゴミ箱へ移すのは既存の `trash` の手順（`pending_ops` の3段階）を使う。新しいファイルの動かし方を作らない
- タグの和集合、元URLの引き継ぎ、ボードの配置の置き換え、カテゴリの変更、ゴミ箱へ移す処理のどこで失敗しても、画像を失わないこと。DB の変更は、できるだけ1つのトランザクションにまとめる。失敗のケースは Rust のテストを先に書く
- ボードの配置の置き換えは、ボードを開いていなくても DB に書く。ボードの取り消しの履歴には入れない。開いているボードのウィンドウには、今の再読み込みの仕組み（`board.rs` と `windows.rs`）で反映する。反映の仕組みがなければ報告して止まる
- 置き換えでは位置、表示の幅、回転、反転、グレースケールを保ち、縦横比が違えば高さを合わせ、トリミングは外す
- 「1枚にまとめる…」は類似画像検索の結果のモードの間だけ、2枚以上を選んだときに出す。ゴミ箱と見つからない画像は含められない
- Tauri のコマンドを足すときは、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる（`npm run lint` が見る）
- `scripts/` と `docs/requirements.md` の4章には触れない（まとまり B が触る）

## タスク

- Rust：残す画像の id、残さない画像の id の並び、残す画像のカテゴリ、残す画像に付けるタグの並びを受け取り、1枚にまとめるコマンドを足す。元URLは残す画像になければ、残さない画像のどれかのものを引き継ぐ（どれを使うかは、残す画像の初期値と同じ順（画素数、ファイルサイズ、取り込み日時））。メモは引き継がない。テストを先に書く
- 画面：右クリックメニュー（`imageMenu`）と、複数選択の詳細パネルに「1枚にまとめる…」を足す。単体テスト（`src/contextMenu.test.ts`）を先に書く
- ダイアログ：選んだ画像のサムネイルを並べ、残す1枚を選ぶ。初期値は画素数（幅×高さ）が一番大きい画像、同じならファイルサイズの大きい方、それも同じなら取り込み日時の古い方。初期値を選ぶ関数に単体テストを先に書く。残す画像のカテゴリを `CategorySelect` で変えられる（初期値は残す画像のもの）。タグは選んだ全部の画像のタグの和集合を出し、1つずつ外せる。実行すると、ゴミ箱へ移す枚数を見せて確かめる
- 結果をステータスバーに出す。結果のモードの一覧から、ゴミ箱に移した画像を消す
- `src/mocks/ipc.ts` にモックの応答を足し、e2e でメニュー、ダイアログ、実行後の一覧を撮る
- `docs/user-guide.md` に「1枚にまとめる」を書く

## 完了の条件

- 2枚と3枚以上で、1枚が残りほかがゴミ箱に移る。ゴミ箱から元に戻せる。戻しても残した画像のタグ、元URL、ボードの配置は変わらない
- 残す画像の初期値、タグの和集合と外す操作、カテゴリの変更が、要件定義書のとおりに動く
- 残さない画像が置かれていたボードで、配置が残す画像に置き換わる（開いているボードと閉じているボードの両方）
- Rust のテストに、途中の失敗（ゴミ箱へ移す途中、DB の書き込みの失敗）で画像を失わないケースがある
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る
- `library.rs` の `apply_op` か `fileops.rs` に触れたら `.claude/skills/verify-crash-safe-move/check.sh` が通る
- verify-kura の手順で実アプリを隔離して起動し、ボードに置いた画像を含む組を1枚にまとめ、Finder（ファイルの場所）、ゴミ箱、ボードで結果を確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-610-merge`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 画像ファイルを削除しない。残さない画像はゴミ箱へ移すだけにする
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### B

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり B、タスク13の前半（FR-611、NFR-03）を担当する。元が同じ画像（同じ写真から大きさ、トリミング、色味を変えた画像）を「元が同じ」とみなす、内容（SigLIP 2）の類似度のしきい値を実測で決める。名前が写しの形の2枚に使う第2のしきい値も決める。決めた値は、後のまとまり D（ライブラリ全体から組を探す）が使う。

まとまり A（1枚にまとめる。`src/`、`src-tauri/`、`src/mocks/ipc.ts` に触れる）が別のセッションで同時に進む。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の4章（内容のモデル、ADR-0018 のサムネイルからの計算）と、5.6 の「元が同じ画像の整理（FR-610、FR-611。フェーズ4b）」の「基準」
- `docs/adr/0033-merge-same-origin-images.md`、`docs/adr/0018-features-from-thumbnails-single-thread.md`
- `docs/tasks/phase4.md` のタスク13
- `ml/src/kura_worker/`（ワーカーの入出力）、`ml/model.json`、`docs/tasks/phase3-design.md` の1章
- `scripts/gen_dev_library.py` とそのテスト（`scripts/` のスクリプトの書き方）
- `spikes/similarity/README.md`（3a の計測のやり方）

## 注意すること

- 見本の写真は `/Users/kk6/Projects/kura-library` を使う。読むだけにし、中身を変えない。変形した組と測った結果は `.claude/tmp/` か一時フォルダに出し、リポジトリにコミットしない
- 類似度は、アプリと同じ経路の値で測る。アプリはサムネイルから特徴量を計算する（ADR-0018）ので、サムネイルと同じ大きさに縮めた画像を `kura_worker` に渡すか、隔離した実アプリのライブラリに取り込んで `features.db` から読む。どちらにしたかを報告に書く
- 類似度は、そろえる前の内容のコサイン類似度を使う。5.6 の「重み」でそろえた値は使わない。構図とポーズは使わない
- モデルのファイルは `spikes/similarity/models/siglip2-b16.onnx` の写しか、`ml/model.json` の `url` から取ったものを使う。`sha256` で確かめる
- `src/`、`src-tauri/`、`src/mocks/ipc.ts` には触れない（まとまり A が触る）

## タスク

- `scripts/` に、見本の写真のフォルダから変形した組を作るスクリプトを足す。変形は縮小（1/2、1/4）、トリミング（90%、75%）、彩度と明るさの変更、JPEG の再圧縮。左右反転は作らない（元が同じに含めないため）。テストを `scripts/` のほかのテストと同じ形で書き、テストの画像はテストの中で作る
- 変形した組の類似度の最小値と、別の写真どうしの類似度の最大値を測る。変形の種類ごとの分布（最小、中央値など）も出す
- しきい値をその間に置く案を出す。名前が写しの形（「abcde 2」「abcdeのコピー」「abcde(1)」「abcde copy」）の2枚に使う第2のしきい値の案も出す
- 最小値と最大値が重なって間がないときは、しきい値を決めずに報告して止まる
- `docs/requirements.md` の4章の「元が同じ画像（FR-610、FR-611）のしきい値」の行に、2つのしきい値、測った写真の枚数、変形の種類ごとの分布、別の写真どうしの最大値を書く。決めたしきい値は利用者が PR で確かめる
- スクリプトの使い方を `CLAUDE.md` の「コマンド」に書く

## 完了の条件

- スクリプトのテスト（`uv run --with pillow --with pytest pytest scripts/`）が通る。`uvx ruff@0.17.3 check` と `uvx ruff@0.17.3 format --check` が通る
- 2つのしきい値の案と、その根拠になった分布が要件定義書の4章にある
- `npm run lint`（ドキュメントの検査を含む）が通る

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-611-threshold`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。見本の写真のフォルダは読むだけにする
- 画像ファイルをリポジトリにコミットしない

## 報告

やったこと、確かめた方法（流したコマンドと結果、測った分布）、2つのしきい値の案とその理由、残った課題を報告して止まる。次のまとまりには進まない。
```

#### C

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり C、タスク13b（FR-109）とタスク13c（FR-108）を担当する。どちらも差分検出のスキップの一覧の手直し。重複として登録しなかったファイルを整理できず、対応していない形式のファイル（動画など）がライブラリに散らばったままになる。細部は 2026-11-23 に利用者と決め、要件定義書に書いてある。

まとまり A（1枚にまとめる、FR-610）は main に入っている。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の5.1 の差分検出の細部（「未対応のファイルと重複の整理（FR-108、FR-109。フェーズ4b。2026-11-23、利用者と決めた）」）、FR-108、FR-109、FR-402、4章の `pending_ops` の手順、8章の「設定（フェーズ4a-2 からの形）」
- `docs/design.md`
- `docs/tasks/phase4.md` のタスク13b、13c、`docs/tasks/phase4-check.md` の B の該当項目
- `src-tauri/src/sync.rs`（`scan`）、`src-tauri/src/fileops.rs`、`src-tauri/src/trash.rs`、`src-tauri/src/library.rs`（`TRASH_DIR`、`connect`、`apply_op`）、`src-tauri/src/category.rs`（画像を移す処理）、`src-tauri/src/settings.rs`
- `src/SkipDialog.tsx`、`src/StatusbarResult.tsx`、`src/importTypes.ts`、`src/SettingsPage.tsx`
- `.claude/skills/verify-kura/SKILL.md`、`.claude/skills/verify-crash-safe-move/SKILL.md`

## 注意すること

- 登録しなかったファイルは、中身が登録済みの画像と同じでハッシュが重なる（`images.hash` は UNIQUE）ので、DB の行を作らない。`.kura/` のゴミ箱の下の別のフォルダへ移すだけにし、アプリのゴミ箱の一覧には出さない。元に戻す操作は作らない。「ゴミ箱を空にする」で一緒に消す（要件定義書5.1）
- ファイルを動かす処理（`_未対応ファイル/` へ移す、登録しなかったファイルを `.kura/` へ移す）は、`pending_ops` の3段階（予定を記録 → 上書きしない rename → DB 更新）に乗せる。移す先で名前が衝突したら連番を付ける。Rust のテストを先に書き、途中の失敗（rename の失敗、DB の失敗、途中で落ちた後の復旧）を含める
- 登録済みの画像を別のカテゴリへ移すのは、FR-402 の既存の移し方を使う
- `_未対応ファイル/` はカテゴリにせず、差分検出で見ない。取り込み（ライブラリの外からのコピー）では移さない
- スキップの一覧は保存しないので、「整理…」と「まとめて移す」は差分検出の直後のスキップの一覧からだけ使える
- 設定は `settings.rs` の `Settings` に足す。前の版の設定ファイルにない項目なので、ない場合は初期値（OFF）で読む。テストを先に書く
- Tauri のコマンドを足すときは、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる

## タスク

- タスク13b（FR-109）：スキップの一覧の重複の行に「整理…」を置く。ダイアログで、登録済みの画像の場所（カテゴリ）と登録しなかったファイルの場所のどちらに残すかを選ぶ。登録しなかった側を残すなら、登録済みの画像をそのカテゴリへ移す。どちらでも、登録しなかったファイルを `.kura/` のゴミ箱の下の別のフォルダへ移す。「1枚にまとめる」（FR-610）とは別のダイアログにする
- 「ゴミ箱を空にする」で、そのフォルダも消す。確認の文言に影響するなら、要件定義書に書いていない文言は報告して止まる
- タスク13c（FR-108）：設定の「一般」に「差分検出で、対応していない形式のファイルを `_未対応ファイル/` へ移す」（初期値 OFF）を置く。ON の間は差分検出のたびに移し、移したファイルと枚数をスキップの一覧で知らせる。OFF の間は、スキップの一覧から対応していない形式のファイルをまとめて移せる
- `src/mocks/ipc.ts` にモックの応答を足し、e2e でスキップの一覧、ダイアログ、設定の「一般」を撮る
- `docs/user-guide.md` を直す

## 完了の条件

- 重複の行の「整理…」で、どちらを残しても、残した場所に1枚があり、登録しなかったファイルが `.kura/` のゴミ箱の下に移る。「ゴミ箱を空にする」で消える
- ON の間は差分検出のたびに対応していない形式のファイルが `_未対応ファイル/` へ移り、次の差分検出で一覧に出ない。OFF の間はスキップの一覧から移せる。取り込みでは移さない
- 設定を切り替えて、起動し直しても残る
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る
- `.claude/skills/verify-crash-safe-move/check.sh` が通る。`DRIFT` が出たら、その SKILL.md の手順でモデルを合わせ直す
- verify-kura の手順で実アプリを隔離して起動し、ダミーのライブラリに重複と動画などのファイルを置いて差分検出し、上の動きを Finder（ファイルの場所）と DB で確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-108-109-skipped`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 画像ファイルを削除しない。消すのは利用者が「ゴミ箱を空にする」を押したときだけ
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### D

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり D、タスク13の後半（FR-611、NFR-03）とタスク17（6章、NFR-12）を担当する。ライブラリ全体から元が同じ画像の組を探し、組ごとに区切った一覧から「1枚にまとめる…」で整理できるようにする。メニューバーの「ファイル」に「似た画像を探す」（⇧⌘F）と「元が同じ画像の組を探す…」を足す。

まとまり A（「1枚にまとめる…」のダイアログとコマンド、FR-610）、B（しきい値の実測）、C（スキップの一覧の整理）は main に入っている。しきい値は B が測り、要件定義書の4章に書いてある。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の4章の「元が同じ画像（FR-610、FR-611）のしきい値」、5.6 の「元が同じ画像の整理（FR-610、FR-611。フェーズ4b）」と「入口と結果」、6章の「フェーズ4b で足すメニューの項目」とショートカットの表（⇧⌘F）、NFR-03
- `GLOSSARY.md` の「元が同じ画像」「組」「1枚にまとめる」
- `docs/design.md`（類似画像検索の帯）
- `docs/tasks/phase4.md` のタスク13、17、`docs/tasks/phase4-check.md` の B の該当項目
- `src-tauri/src/similar.rs`、`src-tauri/src/features.rs`（`load_vectors` に当たる関数）、`src-tauri/src/calc.rs`（進み具合のイベントと中止の作り）、`src-tauri/src/menu.rs`、`src-tauri/src/main.rs` の `on_menu_event`
- `src/Gallery.tsx`（類似画像検索の結果のモード、`listen` しているメニューのイベント）、`src/GalleryToolbar.tsx`、`src/similarity.ts`、A が足した「1枚にまとめる…」のダイアログ、`src/SettingsPage.tsx` の「類似画像検索」
- `.claude/skills/verify-kura/SKILL.md`

## 注意すること

- 基準は内容の、そろえる前のコサイン類似度。4章のしきい値以上の2枚を元が同じとみなす。拡張子を除いた名前が写しの形（「abcde 2」「abcdeのコピー」「abcde(1)」「abcde copy」など）の2枚には第2のしきい値を使う。名前だけでは元が同じとみなさない。写しの形を見分ける関数に Rust のテストを先に書く
- 元が同じとみなした2枚をつないで組にする（A と B、B と C なら A、B、C を1つの組）。ゴミ箱と「見つからない」画像は比べない
- 2万枚で60秒以内（ダミーの特徴量）。探している間はステータスバーに進み具合を出し、中止できる。その間もほかの操作を続けられる。計算の止め方は `calc.rs` の作りに合わせる
- 結果は別の画面にせず、いつもの一覧を組ごとに区切って並べるモードにする。帯に「元が同じ画像 N組」と「閉じる」、組ごとに「1枚にまとめる…」と組を一覧から外す操作を置く。結果も外した組も保存しない。区切りの見た目が `docs/design.md` にないときは、先に案を書いて報告して止まる
- 類似画像検索が OFF の間は、2つのメニューの項目を隠し、⇧⌘F も効かせない。入力欄の中とダイアログを開いている間は ⇧⌘F を効かせない（6章）
- 「似た画像を探す」の押せる条件は詳細パネルのボタンと同じ
- Tauri のコマンドを足すときは、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる

## タスク

- Rust：ライブラリ全体から組を探すコマンドと、中止のコマンドを足す。写しの形の判定、組のつなぎ方、ゴミ箱と見つからない画像を除くことをテストで確かめる。2万件のダミーの特徴量で時間を測るテストか計測の手順を足す
- 入口：メニューバーの「ファイル」の「元が同じ画像の組を探す…」と、設定の「類似画像検索」のボタン
- 結果のモード：組ごとに区切った一覧、帯、組ごとの「1枚にまとめる…」（A のダイアログ）と外す操作。まとめた組は一覧から消える
- タスク17：メニューバーの「ファイル」の「ボードに追加…」の近くに「似た画像を探す」（⇧⌘F）と「元が同じ画像の組を探す…」を足す。類似画像検索の ON/OFF でメニューを作り直す
- `src/mocks/ipc.ts` にモックの応答を足し、e2e で帯、区切った一覧、進み具合を撮る
- `docs/requirements.md` の4章に、2万件で測った時間を書く。`docs/user-guide.md` とショートカットの表を直す

## 完了の条件

- 変形した組を入れたダミーのライブラリで、組が一覧に出て、組ごとに1枚にまとめられる。名前が写しの形の組が、名前の違う組より見つかりやすい
- 2万件のダミーの特徴量で60秒以内。測った時間が要件定義書の4章にある
- 探している間に進み具合が出て、中止できる
- ⇧⌘F と「ファイル」の「似た画像を探す」で、詳細パネルのボタンと同じ操作ができる。類似画像検索が OFF の間は2つの項目が出ず、⇧⌘F も効かない
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る
- verify-kura の手順で実アプリを隔離して起動し、メニューから組を探し、1組をまとめ、中止も試している

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-611-find-groups`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所、測った時間）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### E

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり E、タスク14（FR-606）を担当する。骨格推定の結果（RTMPose-m の COCO 17点）を、拡大表示の画像に重ねて確かめられるようにする。ポーズの類似検索で、なぜその画像が似ているとされたかを見るため。置き場所は 2026-11-23 に利用者と決め、要件定義書に書いてある。

まとまり A〜D は main に入っている。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の5.6 の「骨格の重ね表示とギャラリー外の画像で探す（FR-606、FR-608。フェーズ4b）」、4章の骨格推定（RTMPose-m、COCO 17点、複数人）、5.6 の FR-605 の理由（人物がいない、手足が足りない、未計算、モデルがない）
- `docs/adr/0019-rtmpose-m-for-pose.md`、`docs/adr/0018-features-from-thumbnails-single-thread.md`
- `docs/design.md`（拡大表示の上の帯、色の決まり）
- `docs/tasks/phase4.md` のタスク14、`docs/tasks/phase4-check.md` の B の該当項目
- `src-tauri/src/features.rs`（`poses` の表、`pose_row`、`load_poses`）、`ml/src/kura_worker/`（関節の座標の形と座標系）
- `src/ZoomPanel.tsx`、`src/useZoom.ts`、`src/zoomView.ts`（反転・回転・グレースケールの表示）
- `.claude/skills/verify-kura/SKILL.md`

## 注意すること

- 関節の座標はサムネイルから計算している（ADR-0018）。どの座標系（サムネイルのピクセルか、0〜1か）で保存しているかを `kura_worker` と `features.rs` で確かめ、拡大表示の画像の大きさに合わせて変換する。変換の関数に単体テストを先に書く
- 反転・回転の表示の状態に合わせて骨格も重ねる。グレースケールは骨格に影響しない
- 骨格の線と点の色は `docs/design.md` の決まりに従う（白・黒・グレーと決まった例外の色だけ）。写真の上で見える色の決まりがなければ、案を書いて報告して止まる
- ポーズのない画像と、類似画像検索が OFF の間は切り替えを出さない。初期値は OFF で、状態は保存しない
- Tauri のコマンドを足すときは、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる

## タスク

- Rust：1枚の画像の、今のモデルのポーズ（全員の関節の座標と、使えない関節の印）を返すコマンドを足すか、`image_detail` に足す。ポーズのない画像では「ない」と理由を返す。テストを先に書く
- 画面：拡大表示の上の帯に「骨格を重ねる」の切り替えを置き、ON の間は全員の骨格を SVG で重ねる。関節を結ぶ線は COCO 17点の骨格のつながりにする
- `src/mocks/ipc.ts` にポーズのある画像とない画像のモックを足し、e2e で ON、OFF、反転、回転、ポーズのない画像を撮る
- `docs/user-guide.md` と、骨格の見た目を決めたなら `docs/design.md` を直す

## 完了の条件

- ポーズのある画像で、骨格が関節の位置に重なる。反転・回転しても合う。複数人の画像で全員分が出る
- ポーズのない画像と、類似画像検索が OFF の間は切り替えが出ない
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る
- verify-kura の手順で実アプリを隔離して起動し、ポーズのモデルを入れて計算した人物の写真で、骨格が重なることをスクリーンショットで確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-606-pose-overlay`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。人物の写真は見本の写真のフォルダ（`/Users/kk6/Projects/kura-library`。読むだけ）から隔離したライブラリへ取り込んで使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### F

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり F、タスク16（FR-608）を担当する。ギャラリーの外の画像（ブラウザやデスクトップの画像）を検索バーの隣の「画像で探す」にドロップし、似た画像をギャラリーから探せるようにする。ドロップした画像は取り込まない。落とし先は 2026-11-23 に利用者と決め、要件定義書に書いてある。

まとまり A〜E は main に入っている。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の5.6 の「骨格の重ね表示とギャラリー外の画像で探す（FR-606、FR-608。フェーズ4b）」と「入口と結果」「重み」、FR-201（ドロップでの取り込み）、NFR-08
- `docs/design.md`（検索バー、類似画像検索の帯）
- `docs/tasks/phase4.md` のタスク16、`docs/tasks/phase4-check.md` の B の該当項目
- `src-tauri/src/similar.rs`（`similar`、基準画像の特徴量の読み方、観点ごとのそろえ方）、`src-tauri/src/worker.rs`、`src-tauri/src/calc.rs`（ワーカーへの頼み方、サムネイルの作り方）、`src-tauri/src/main.rs` の `similar_images`
- `src/Gallery.tsx`（ドロップでの取り込み、類似画像検索の結果のモード）、`src/GalleryToolbar.tsx`、`src/SearchBox.tsx`、`src/similarity.ts`
- `.claude/skills/verify-kura/SKILL.md`

## 注意すること

- ドロップした画像は、ライブラリのファイルにも DB（`kura.db`、`features.db`）にも書かない。サムネイルや一時ファイルが要るなら、ライブラリの外（アプリの一時フォルダ）に作り、結果を閉じたら消す
- 特徴量はライブラリの画像と同じ経路（サムネイルから計算。ADR-0018）で計算する。ライブラリの特徴量の計算が動いているときのワーカーとの順番は、`worker.rs` と `calc.rs` の作りに合わせる。作りを大きく変える必要があれば報告して止まる
- 結果は「似た画像を探す」と同じモードと帯にする。帯の基準画像には落とした画像を出し、一覧には並べない。結果の中の画像から「似た画像を探す」を押すと、いつもどおり基準が入れ替わる
- 「画像で探す」はファイルをドラッグしている間だけ落とし先として目立たせる。ほかの場所に落とすと今までどおり取り込む。押すとファイル選択を開く
- 落とせるのは対応している形式の画像1枚。それ以外（複数、フォルダ、対応していない形式）は探さずに理由を出す
- 類似画像検索が OFF の間は「画像で探す」を出さない
- 外部への通信を増やさない（NFR-08）。ブラウザから落とした画像が URL だけのときの扱いが要件定義書にないなら、報告して止まる
- Tauri のコマンドを足すときは、`main.rs` の `generate_handler!`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる

## タスク

- Rust：ライブラリの外のファイルのパスを受け取り、その場で特徴量を計算し、ライブラリの画像を類似度の順に返すコマンドを足す。基準をライブラリの画像の id から特徴量に一般化するなら、今の `similar` の結果が変わらないことをテストで確かめる。ライブラリに何も書かないことをテストで確かめる
- 画面：検索バーの隣の「画像で探す」、ドラッグ中の目立たせ方、ファイル選択、結果のモードの帯の基準画像
- `src/mocks/ipc.ts` にモックの応答を足し、e2e で「画像で探す」、ドラッグ中、結果の帯を撮る
- `docs/user-guide.md` と、見た目を決めたなら `docs/design.md` を直す

## 完了の条件

- ギャラリーの外の画像を「画像で探す」に落とすと、似た画像の結果が出る。ほかの場所に落とすと今までどおり取り込む
- ライブラリのファイルと DB が変わらない（verify-kura で、探す前後のファイルの一覧と DB を比べる）
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る
- verify-kura の手順で実アプリを隔離して起動し、デスクトップのファイルと、ライブラリの画像を縮小したファイルを落として、結果を確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-608-search-by-image`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### G

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4b（`docs/tasks/phase4.md` のタスク11〜19）のまとまり G、タスク18を担当する。A〜F（FR-610、FR-611 のしきい値と組を探す操作、FR-109、FR-108、FR-606、FR-608、6章のメニューの項目と ⇧⌘F）は main に入っている。リリースの準備をし、利用者がリリース用ビルドで phase4-check の B を確かめられる状態にする。

## 先に読むもの

- `CLAUDE.md` の「コマンド」の「リリース」と「ドキュメントのスクリーンショット」
- `docs/tasks/phase4.md` のタスク9とタスク18、`docs/tasks/phase4-check.md` の B
- `.claude/skills/verify-kura/SKILL.md`、`CHANGELOG.md`、`README.md`、`homepage/`

## 注意すること

- 版は利用者が決める。ブリーフに版が書いていなければ、報告して止まる
- スクリーンショットは `KURA_DOCS_PHOTOS=/Users/kk6/Projects/kura-library npm run docs:screenshots` で撮る。見本の写真のフォルダは読むだけにする

## タスク

- verify-kura に、1枚にまとめる手順、元が同じ画像の組を探す手順、スキップの一覧の「整理…」と `_未対応ファイル/` へ移す手順、骨格の重ね表示、「画像で探す」の手順を足す
- phase4-check の B に必要な操作と証跡をそろえる。試し用のライブラリに変形した組を入れる手順を書く（まとまり B のスクリプトを使う）
- `docs/user-guide.md`、README の「できること」と「まだできないこと」、紹介ページを CHANGELOG の項と照らして直す。スクリーンショットを撮り直す
- `CHANGELOG.md` に項を書き、`npm run version:set` で版をそろえる（版は利用者が決めたもの）
- `docs/tasks/phase4.md` の進み具合を直す

## 完了の条件

- `npm run lint`、`npm test`、`npm run test:e2e`、`cargo test` が通る
- phase4-check の B の各項目に、確かめる操作が書いてある
- README、ユーザーガイド、紹介ページに、A〜F の変更が載っている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `chore/4b-release-prep`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す
- タグの作成と push、GitHub Release の作成はしない

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

## 4a-2

2026-11-23 作成。進行役のセッションが、まとまりごとに作業セッションを始めるときに渡すブリーフです。タスク30（未決事項を決める）は進行役のセッションで利用者と済ませました。

### まとまり

[phase4.md](phase4.md) のタスク31〜36を、1回のセッションで頼める大きさに分けています。タスク37は利用者の確認です。

| まとまり | タスク | 内容 | 前提 | 並行 | ブランチ |
| --- | --- | --- | --- | --- | --- |
| A | 31 | 右クリックでカテゴリを変える（FR-416）（完了：#61、2026-11-23） | タスク30 | B と並行できる | `feat/fr-416-context-category` |
| B | 32、33 | 除いたものをグレーにする、サイドバーのタグの検索欄（FR-517、FR-518）（完了：#60、2026-11-23） | タスク30 | A と並行できる | `feat/fr-517-518-sidebar` |
| C | 35、34 | 設定の種類ごとのページ、タグ管理の移動、最近使ったタグの設定（8章、FR-408、FR-419）（完了：#62、2026-11-23） | A、B | しない | `feat/settings-kinds` |
| D | 36 | 検証手順、文書、リリース準備（完了：#64、0.6.2、2026-11-23） | C | しない | `chore/4a-2-release-prep` |

分け方の理由：

- A と B は触るファイルが重ならない。A は `src/contextMenu.ts`、`src/Gallery.tsx`、`src/Classify.tsx`、新しいダイアログ。B は `src/Sidebar.tsx`、`src/Sidebar.css`、名前の比べ方（`src/choices.ts`、`src/filter.ts`）。A は既存のコマンドだけを使うので `main.rs` と `src/mocks/ipc.ts` に触れない見込み。触れる必要が出たら、A を進め、B は `src/mocks/ipc.ts` に触れない
- C は `src/Gallery.tsx`（設定の間のサイドバー、タグ管理の開き方）と `src/Sidebar.tsx`（タグ管理のボタン）に触れるので、A と B を統合してから始める。タスク34 と35 は同じ設定の「タグ」のページを作るので、1度に作る。`settings.rs` と `src/mocks/ipc.ts` に触れるのは C だけ
- D は作った機能を通して確かめる作業と文書の作業で、新しい機能を足さない

各まとまりは main から切り、終わったら main へマージします。

### ブリーフ

#### A

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4a-2（`docs/tasks/phase4.md` のタスク30〜37）のまとまり A、タスク31（FR-416）を担当する。一覧と拡大表示の右クリックメニューから、選んだ画像のカテゴリを変えられるようにする。今は詳細パネルでしか変えられない。操作の細部は 2026-11-23 に利用者と決め、要件定義書に書いてある。

まとまり B（サイドバー）が別のセッションで同時に進む。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の5.4 の「カテゴリの設定とタグの付け外しの細部」「右クリックメニューからのカテゴリの変更（FR-416）の細部」「カテゴリの作成（FR-401）の画面」
- `docs/design.md`
- `docs/tasks/phase4.md` のタスク31、`docs/tasks/phase4-check.md` の該当項目
- `src/contextMenu.ts`（`imageMenu`）、`src/Gallery.tsx` の右クリックの扱い、`src/Classify.tsx` の `CategorySelect`、カテゴリを移す既存の処理（詳細パネルから呼ぶもの）
- `.claude/skills/verify-kura/SKILL.md`

## 注意すること

- 移す処理とカテゴリを作る処理は、詳細パネルとサイドバーが使う既存のコマンドをそのまま使う。Rust のコマンドを足す必要が出たら、`main.rs`、`src/mocks/ipc.ts`、画面の `invoke` をそろえる（`npm run lint` の検査が見る）
- ダイアログの選択欄は `CategorySelect` を使い、詳細パネルと同じ操作（名前で絞り込み、上下キーと Enter）にする
- まとまり B と触るファイルを重ねない。`src/Sidebar.tsx`、`src/Sidebar.css`、`src/choices.ts`、`src/filter.ts` には触れない

## タスク

- `imageMenu` に「カテゴリを変える…」と「1つ上のカテゴリへ移す」を足す。ゴミ箱と見つからない画像のメニューには出さない。単体テスト（`src/contextMenu.test.ts`）を先に書く
- 「カテゴリを変える…」でダイアログを開く。見出しに枚数を出す。移す先は `CategorySelect` で選ぶ。「新しいカテゴリ」の欄に名前を入れ、作る場所（ルート直下か既存のカテゴリの下）を選択欄で選ぶと、作ってからそこへ移す。名前の扱いと作れないときのエラーは FR-401 と同じ
- 「1つ上のカテゴリへ移す」はダイアログなしで今のカテゴリの親へ移す。未分類の画像か一番上の階層のカテゴリの画像を1枚でも含むときは押せない。カテゴリが揃っていない複数の画像は、それぞれの1つ上へ移す
- 移し方は詳細パネルと同じ（1枚ずつ、移せない画像は残して続け、結果をステータスバーに出す）
- `docs/user-guide.md` に右クリックからの変え方を書く

## 完了の条件

- 1枚と複数で、既存のカテゴリ、新しく作ったカテゴリ、1つ上のカテゴリの3種類へ移せる。拡大表示の右クリックでも同じ
- 未分類と一番上の階層の画像で「1つ上」が押せない
- `npm run lint`、`npm test`、`npm run test:e2e` が通る。モックの画面のスクリーンショットでメニューとダイアログを確かめている
- verify-kura の手順で実アプリを隔離して起動し、3種類の移し方で Finder（ファイルの場所）でも画像が移ったことを確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-416-context-category`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### B

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4a-2（`docs/tasks/phase4.md` のタスク30〜37）のまとまり B、タスク32（FR-517 の表示）とタスク33（FR-518）を担当する。どちらもサイドバーの手直し。除いたタグとカテゴリが、選んだものと見分けにくい。タグが多く、サイドバーで目的のタグを探しにくい。

まとまり A（右クリックでカテゴリを変える）が別のセッションで同時に進む。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の FR-517、FR-518 と5.5 の「絞り込みの細部」
- `docs/design.md`
- `docs/tasks/phase4.md` のタスク32、33、`docs/tasks/phase4-check.md` の該当項目
- `src/Sidebar.tsx`、`src/Sidebar.css`、`src/choices.ts`（`tagKey`）、`src/filter.ts`

## 注意すること

- 名前の比べ方は検索バーの候補と同じ（NFC、大文字・小文字を無視）。`src/choices.ts` か `src/filter.ts` の既存の比べ方を使う
- まとまり A と触るファイルを重ねない。`src/Gallery.tsx`、`src/contextMenu.ts`、`src/Classify.tsx`、`src/mocks/ipc.ts` には触れない
- 検索欄の置き場所と見た目のうち、要件定義書に書いていない細部（入力中の件数の出し方、閉じたタグ一覧での扱いなど）は、`docs/design.md` の既存の入力欄に合わせる。合わせ方が決まらなければ報告して止まる

## タスク

- タスク32：除いたカテゴリは名前の文字をグレーに、除いたタグはタグの表示そのものをグレーにする。取り消し線は残す。色は `tokens.css` のグレーを使う
- タスク33：サイドバーのタグ一覧の上に、名前でタグを絞り込む検索欄を置く。入力した文字を名前に含むタグだけを出す。絞り込みの関数に単体テストを先に書く
- `docs/user-guide.md` と、見た目を決めたなら `docs/design.md` を直す

## 完了の条件

- スクリーンショットで、除いたもの、選んだもの、何もしていないものを見分けられる（カテゴリとタグの両方）
- 2,000 個のタグのモックで、入力した文字を含むタグだけが出る。大文字・小文字と NFC の違いを無視する
- `npm run lint`、`npm test`、`npm run test:e2e` が通る

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/fr-517-518-sidebar`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### C

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4a-2（`docs/tasks/phase4.md` のタスク30〜37）のまとまり C、タスク35（8章、FR-408）とタスク34（FR-419）を担当する。設定のページを種類ごとに分け、タグ管理をダイアログから設定の「タグ」に移し、最近使ったタグの設定を足す。種類の分け方と初期値は 2026-11-23 に利用者と決め、要件定義書に書いてある。

まとまり A（右クリックでカテゴリを変える）と B（サイドバー）は main に入っている。

## 先に読むもの

- `CLAUDE.md`
- `docs/requirements.md` の8章の「設定」「設定（フェーズ4a-2 からの形）」「タグ管理」の行、5.4 の「タグ管理（FR-408）の細部」と最近使ったタグの項目、FR-419
- `docs/design.md`、`GLOSSARY.md` の「設定の種類」
- `docs/tasks/phase4.md` のタスク34、35、`docs/tasks/phase4-check.md` の該当項目
- `src/SettingsPage.tsx`、`src/Gallery.tsx` の設定とタグ管理の開き方、`src/TagDialog.tsx`、`src/Sidebar.tsx`、`src/Classify.tsx` の最近使ったタグ、`src-tauri/src/settings.rs`、`src/mocks/ipc.ts`

## 注意すること

- 種類は「一般」「タグ」「アイデアボード」「類似画像検索」「元URL」「バックアップ」の順。4a の枠の中身をそのまま移し、項目の動きは変えない
- 最近使ったタグの設定は `settings.rs` の `Settings` に足す。前の版の設定ファイルにない項目なので、ない場合は初期値（出す・5件）で読む。テストを先に書く
- タグ管理の名前の比べ方は検索バーの候補と同じ（NFC、大文字・小文字を無視）。B がサイドバーに入れた絞り込みの関数があれば使う
- サイドバーのタグの見出しにある、タグ管理を開くボタンの行き先は設定の「タグ」にする
- 今の設定の開き方（⌘,、歯車のアイコン）と閉じ方（Escape、もう一度歯車）は変えない。「ギャラリーに戻る」を足す

## タスク

- 設定を開いている間は、左のサイドバーにカテゴリツリーとタグ一覧の代わりに設定の種類を出し、選んだ種類のページを出す。「ギャラリーに戻る」でギャラリーに戻る
- タグ管理をダイアログから設定の「タグ」に移し、名前でタグを絞り込む検索欄を置く。名前変更、統合、削除の動きは今のまま
- 設定の「タグ」に、最近使ったタグを出すかどうか（トグル）と件数（5、10、15）を置き、アプリ全体の設定に保存する。詳細パネルの最近使ったタグを設定に従わせる
- 使わなくなったダイアログのコードと CSS を消す
- `docs/user-guide.md` を直し、`npm run docs:screenshots` で撮り直しが要る画面があれば報告に書く（撮り直しはまとまり D で行う）

## 完了の条件

- 今の設定とタグ管理の操作が、すべて新しいページから行える
- 最近使ったタグを切り替えると詳細パネルの件数が変わり、起動し直しても残る（verify-kura で実アプリを隔離して起動し、確かめる）
- `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`npm run lint`、`npm test`、`npm run test:e2e` が通る。モックの画面のスクリーンショットで各種類のページを確かめている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `feat/settings-kinds`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```

#### D

```text
Read /Users/kk6/.claude/plugins/marketplaces/cursor-plugins/pstack/skills/poteto-mode/worker.md before anything else.

## 背景

Kura のフェーズ4a-2（`docs/tasks/phase4.md` のタスク30〜37）のまとまり D、タスク36を担当する。A〜C（FR-416、FR-517 の表示、FR-518、FR-419、設定の種類、タグ管理の移動）は main に入っている。リリースの準備をし、利用者がリリース用ビルドで phase4-check の A-2 を確かめられる状態にする。

## 先に読むもの

- `CLAUDE.md` の「コマンド」の「リリース」と「ドキュメントのスクリーンショット」
- `docs/tasks/phase4.md` のタスク9とタスク36、`docs/tasks/phase4-check.md` の A-2
- `.claude/skills/verify-kura/SKILL.md`、`CHANGELOG.md`、`README.md`、`homepage/`

## 注意すること

- 版は利用者が決める。ブリーフに版が書いていなければ、報告して止まる
- スクリーンショットは `KURA_DOCS_PHOTOS=/Users/kk6/Projects/kura-library npm run docs:screenshots` で撮る。見本の写真のフォルダは読むだけにする

## タスク

- verify-kura に、右クリックでカテゴリを変える手順と、最近使ったタグの設定が残る手順を足す
- phase4-check の A-2 に必要な操作と証跡をそろえる
- `docs/user-guide.md`、README の「できること」、紹介ページを CHANGELOG の項と照らして直す。スクリーンショットを撮り直す
- `CHANGELOG.md` に項を書き、`npm run version:set` で版をそろえる（版は利用者が決めたもの）
- `docs/tasks/phase4.md` の進み具合を直す

## 完了の条件

- `npm run lint`、`npm test`、`npm run test:e2e`、`cargo test` が通る
- phase4-check の A-2 の各項目に、確かめる操作が書いてある
- README、ユーザーガイド、紹介ページに、A〜C の変更が載っている

## 守ること

- 未決事項（`docs/requirements.md` の10章）に当たる判断や、要件定義書に書いていない操作・表示の判断が要るときは、自分で決めずに報告して止まる。worker.md の「質問せず、自分で選んで進める」より優先する
- PR のタイトルは `feat: <日本語の要約>（FR-xxx）` の形にし、説明は日本語の `## 変更`、`## 理由` の見出しで書く。worker.md の PR の形より優先する
- マージと main への push はしない。worker.md より優先する
- ブランチは `chore/4a-2-release-prep`。main の最新から切る
- コミットメッセージに FR の ID を書く。コードのコメントは日本語で書く
- 本物の資料フォルダには触れない。読み取りもしない。試すには `scripts/` のダミーを使う
- 色・文字サイズ・余白は `src/styles/tokens.css` の変数だけを使う
- 画面の動きや文言を変えたら `docs/user-guide.md` も直す
- タグの作成と push、GitHub Release の作成はしない

## 報告

やったこと、確かめた方法（流したコマンドと結果、スクリーンショットの場所）、残った課題を報告して止まる。次のまとまりには進まない。
```
