# フェーズ4a-2 のまとまりとブリーフ

2026-11-23 作成。進行役のセッションが、まとまりごとに作業セッションを始めるときに渡すブリーフです。タスク30（未決事項を決める）は進行役のセッションで利用者と済ませました。

## まとまり

[phase4.md](phase4.md) のタスク31〜36を、1回のセッションで頼める大きさに分けています。タスク37は利用者の確認です。

| まとまり | タスク | 内容 | 前提 | 並行 | ブランチ |
| --- | --- | --- | --- | --- | --- |
| A | 31 | 右クリックでカテゴリを変える（FR-416）（完了：#61、2026-11-23） | タスク30 | B と並行できる | `feat/fr-416-context-category` |
| B | 32、33 | 除いたものをグレーにする、サイドバーのタグの検索欄（FR-517、FR-518）（完了：#60、2026-11-23） | タスク30 | A と並行できる | `feat/fr-517-518-sidebar` |
| C | 35、34 | 設定の種類ごとのページ、タグ管理の移動、最近使ったタグの設定（8章、FR-408、FR-419） | A、B | しない | `feat/settings-kinds` |
| D | 36 | 検証手順、文書、リリース準備 | C | しない | `chore/4a-2-release-prep` |

分け方の理由：

- A と B は触るファイルが重ならない。A は `src/contextMenu.ts`、`src/Gallery.tsx`、`src/Classify.tsx`、新しいダイアログ。B は `src/Sidebar.tsx`、`src/Sidebar.css`、名前の比べ方（`src/choices.ts`、`src/filter.ts`）。A は既存のコマンドだけを使うので `main.rs` と `src/mocks/ipc.ts` に触れない見込み。触れる必要が出たら、A を進め、B は `src/mocks/ipc.ts` に触れない
- C は `src/Gallery.tsx`（設定の間のサイドバー、タグ管理の開き方）と `src/Sidebar.tsx`（タグ管理のボタン）に触れるので、A と B を統合してから始める。タスク34 と35 は同じ設定の「タグ」のページを作るので、1度に作る。`settings.rs` と `src/mocks/ipc.ts` に触れるのは C だけ
- D は作った機能を通して確かめる作業と文書の作業で、新しい機能を足さない

各まとまりは main から切り、終わったら main へマージします。

## ブリーフ

### A

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

### B

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

### C

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

### D

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
