# design-sync notes (Kura)

- Kura はアプリで dist/ も .d.ts も無い。`.design-sync/entry.ts` が同期する部品だけを書き出し、`cfg.entry` で変換ツールに渡す。部品を足すときは entry.ts、`componentSrcMap`、`dtsPropsFor` の3か所に足す。
- 同期する部品は Tauri の `invoke` を呼ばないものだけ（2026-11-14 に利用者と決めた）。invoke を呼ぶ画面の部品はモックが要るので入れない。
- props の型は自動で取れない（.d.ts が無いため `[key: string]: unknown` になる）。`dtsPropsFor` に手で書く。部品の props を変えたらここも直す。
- トークンは entry.ts が `src/styles/tokens.css` を import し、`_ds_bundle.css` に入る。`tokensGlob` は使わない（tokens/ は空のまま）。
- ConfirmDialog は `showModal()` で開くので `cardMode: single` と viewport を指定している。
- 検査には Playwright の Chromium が要る（リポジトリの e2e は WebKit だけ）。`npx playwright install chromium`。
- `.ds-sync/` には playwright@1.64.1 を入れる（リポジトリの @playwright/test と版をそろえる）。

## Known render warns

- なし

## Re-sync risks

- `dtsPropsFor` は手書きなので、`src/ConfirmDialog.tsx`、`src/Status.tsx`、`src/icons.tsx` の props が変わると黙って古くなる。
- `conventions.md` のトークンとクラスの一覧は `tokens.css` と `base.css` の写し。トークンを足したり消したりしたら直す。
- `guidelines/docs/design.md` はビルドのたびに写すので古くならない。
