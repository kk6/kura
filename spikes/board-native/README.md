# タスク0 ネイティブ機能と保存待ちの実証

FR-705、FR-707、FR-711、NFR-10。フェーズ2の本体実装に入る前に、別ウインドウ、最前面、不透明度、保存待ちによる閉じる・終了の中止を実macOSで確かめる。使い捨ての独立したTauriアプリであり、本体から参照しない。

## 再実行

リポジトリルートで実行する。既存の検証アプリが動いていれば起動を止める。

```bash
bash spikes/board-native/run.sh
```

Cargoの依存は取得済みであることを前提に `--offline` でビルドする。GUIを起動できる実行環境が必要。コマンドは終了まで動き続ける。開発サーバーとポート5173は使わない。

起動時に `.claude/tmp/phase2-native/run-<日時>/` を表示する。中の `KuraNativeSpike.app` が操作対象。`HOME`、アプリ識別子、保存先を本体から分離し、本体の履歴・設定を読まない。実行ファイルもrun内へ複製する。アプリは起動時にHOMEの一致をassertし、`events.log` に記録する。画像はHTML内の人工図形であり、画像ファイルや実ライブラリを読まない。

生成した `ui/tokens.css`、Cargoの出力、アプリ、画像の証跡はコミットしない。`tokens.css` は本体から起動時にコピーする。

操作は `.claude/skills/verify-kura/drivers/codex.md` のCUA手順を使う。本体の `kura-verify.sh launch` は本体を起動するため、この独立実証では使わない。アプリを強制停止する代わりに、保存失敗をOFFにして⌘Qで終える。

1. ボードの「不透明度30%」「不透明度65%」「100%に戻す」を押す。本文・人工画像だけでなく、タイトルバーも薄くなり戻ることを確認する。
2. 最前面ONで別アプリを表示する。OFFにして同じ操作を繰り返す。Stage Manager使用中は別アプリが縮小表示のままでないことを確認する。
3. 「人工配置を編集」「保存失敗 ON/OFF」を押す。赤い閉じるボタン、⌘W、⌘Q、OFFを個別に試す。3秒待っても窓とrevisionが残り、失敗を表示する。
4. 保存失敗をOFFにして⌘Wを押す。3秒後にボードだけが閉じ、ギャラリーと `snapshot.txt` が残る。
5. ギャラリーでも保存失敗をONにして赤い閉じるボタンを試す。終了が中止される。失敗をOFFにして再試行する。
6. 別のrunで編集後に⌘Qを押す。保存完了後にプロセスが終了し、最後のrevisionが `snapshot.txt` に残ることを確認する。

前後関係はCUAで操作した後、次の読み取り専用の補助プログラムでも記録できる。対象2アプリの順序・レイヤー・不透明度・位置だけを出し、ほかのアプリの情報は出さない。小さいorderが前。画面キャプチャやUI操作はしない。

```bash
swiftc -module-cache-path .claude/tmp/phase2-native/swift-cache \
  spikes/board-native/windows.swift -o .claude/tmp/phase2-native/windows
.claude/tmp/phase2-native/windows
```

## 実機で確認した結果

2026-11-08、macOS 27.0.1、Apple M5 Max、arm64、内蔵Retinaディスプレイ、Stage Manager有効。Tauri 2.12.5、tao 0.37.2、muda 0.20.0、objc2-app-kit 0.3.2。独立実証はデバッグビルド。本体の性能測定や製品版の受け入れ確認ではない。

証跡の基点は `.claude/tmp/phase2-native/`。次のrunを残している。

| run | 観察結果と証跡 |
| --- | --- |
| `run-20261108-220029` | `evidence/alpha30.png`、`alpha65.png`、`alpha100.png`。タイトルバーを含む変化を観察。`events.log` でNSWindowのalphaが0.3、0.65、1.0、`ignoresMouseEvents=false`。30%でもボタンが操作できた。赤い閉じるボタンと⌘Wは失敗後もrevision=1を保持。既定の⌘Qは保存待ちを通らず終了した |
| `run-20261108-220409` | 保存待ちに接続した⌘Q、OFF、ギャラリーの赤い閉じるボタンが、人工の保存失敗で中止。`evidence/quit-wait.png`、`quit-failed.png`、`gallery-close-failed.png` と `events.log`。⌘Wの成功後はギャラリーが残り、`snapshot.txt` はrevision=1 |
| 同runの `evidence/top-on.txt` | ボードのwindow 23447はorder=9、layer=5、600×500。電卓の23484はorder=11、layer=0、230×408。ギャラリー23446はlayer=0。別アプリを通常表示してもボードが前に残った |
| 同runの `evidence/top-off.txt` | 電卓23484はorder=10、layer=0。ボード23447はorder=22、layer=0でStage Managerの縮小表示。通常の前後関係に戻った |
| `run-20261108-221402` | 編集直後の⌘Qで保存待ちを表示し、revision=1を保存後に終了。`evidence/quit-success-wait.png`、`events.log`、`snapshot.txt` と実行セッションの終了コード0を確認 |
| `run-20261108-221734` | レビュー後の最終ソースから再ビルド。最前面ONで閉じて開き直し、`evidence/reopened-top-on.png` と `reopened-top-on.txt` で表示と実際のlayer=5が一致。ギャラリーはlayer=0。⌘Qで保存後に終了コード0 |

`run-20261108-220409` では、OFFの保存成功後にボードが閉じ、最後にギャラリーの赤い閉じるボタンから保存して終了する経路も確認した。実行セッションの終了コードは0。画像の見た目とプロセス終了は実操作で確認し、記録ファイルの整合性は次で再検査できる。

```bash
python3 spikes/board-native/check-evidence.py \
  .claude/tmp/phase2-native/run-20261108-220029 \
  .claude/tmp/phase2-native/run-20261108-220409 \
  .claude/tmp/phase2-native/run-20261108-221402
```

この検査は記録の整合性だけを確認し、GUIの再実行や保存待ちの自動操作を代行しない。前後関係の比較では、今回記録した窓寸法と、同じwindow IDを使用する。

保存失敗は処理内で明示的にエラーを返す人工的な注入である。外付けドライブやDBの書き込み失敗を再現したものではない。実際の保存先はrun内のテキスト1件であり、ボードDB・メモ保存・バックアップは実装していない。

## 本体へ組み込む方法

### ウインドウと不透明度

Tauriの専用WebviewWindowを1つ作り、既存なら手前に出す。`set_always_on_top` は専用窓だけに適用する。不透明度はCSSではなく、その窓の `NSWindow.setAlphaValue` に設定する。`run_on_main_thread` の内側で `ns_window()` を取得して使う。ポインターを別スレッドへ渡したり、窓の破棄後まで保持したりしない。30〜100%の範囲検査はRustの入口で行う。

Tauriの高水準APIには本実証で使える不透明度設定がなかった。実証で使用したAppKitの直接呼び出しなら、合意済みのウインドウ全体への適用に対応できた。位置・サイズの永続化、画面外補正、複数ディスプレイ、最小化、固定中の製品ダイアログはタスク11・17の対象で、本実証では合格にしていない。

### 保存待ちと終了

状態を `Editing → Saving → Editing / ExitApproved` としてRustで持つ。CloseRequestedではその場で `prevent_close()` し、非同期保存後だけ専用窓を `destroy()` する。ギャラリーのCloseRequestedでは両画面の保存を待ち、成功後だけ `app.exit(0)` を呼ぶ。ExitRequestedは終了許可済みの場合だけ通す。保存中は追加の編集を受け付けず、失敗時は窓・編集内容を残して遷移を中止する。

**既定の終了メニューを残したまま、ExitRequestedだけで⌘Qを止めることはできなかった。** 実証の最初のrunは、失敗ONでもExitRequestedのログなしで終了した。インストール済みmudaのmacOS実装で、既定のQuitが `terminate:` を呼ぶことも確認した。通常の `MenuItem` に⌘Qを割り当て、`on_menu_event` から同じ保存待ちへ接続すると中止できた。本体の `menu.rs` の既定Quitも、タスク5でこの接続に置き換える必要がある。メニュー全体を組み替える必要はない。

Dockからの終了、OSのログアウト・再起動、強制終了はこの実証で確認していない。特にAppKitのterminate経路をExitRequestedで捕捉できると推測しない。Dock等も保存待ちの対象とする実装では、AppKitの終了通知への接続を別途実証してから完了扱いにする。

本体ではメモとボードの保存要求を同じ終了処理でflushする。ボード切り替え、OFF、ライブラリ切り替えにも同じ待機を適用する。各画面が独立に終了を許可する構成は避け、Rustの1か所で遷移を確定する。途中で終了要求が重なったときの集約と、再試行後にどの遷移を行うかはタスク5でテストする。本実証は最初の要求を処理中、次の要求を受け付けない。

### ライブラリ識別と遅れて届く保存

現在の `Current(Mutex<Option<Library>>)` と `with_library` は、実行時に開いているライブラリへ書く。画像IDと本文だけの `set_memo` は、古い画面の要求を見分けられない。画面の `Gallery.leave` もメモのblur後、保存のPromiseを待たず切り替える。これは後続タスクで直す箇所であり、今回の本体変更には含めない。

本体では次の識別を持たせる。

- ライブラリを開くたびに新しいセッショントークンをRustで発行する。A→B→Aでも再利用しない。パスやDB内の連番IDだけで識別しない。
- ボードを開くたびの編集セッションと、配置・視点のrevisionを保存要求に付ける。ボードIDだけでは閉じて開き直した古い窓を区別できない。
- 保存要求のトークンはCurrentのロック取得後、DB更新の直前に検査する。同じクリティカルセクションで対象DBを確定する。古い要求を現在のDBに振り替えない。
- 同じ編集セッションの保存を順序付ける。古いrevisionで新しい内容を巻き戻さず、保存応答にもセッションとrevisionを返す。画面は現在のrevisionと一致する応答だけを保存済みと表示する。
- 切り替え中は新規編集を止め、旧ライブラリのメモとボードを保存し、成功後に窓を破棄して次のライブラリへ切り替える。失敗したらトークンもCurrentも変えない。
- 画像参照は画像の永続的な識別子と配置IDを分ける。完全削除済みの画像を古い保存・Undoから復活させない。ID再利用への対策はタスク1・12で保存形式と合わせて検証する。

タスク1・5のテストでは、A/Bで同じボードID・画像IDを用意し、A→BだけでなくA→B→Aへの遅延要求、逆順の保存応答、閉じた旧窓の要求も検査する。これは設計上の提案であり、本体での実証済み結果ではない。

### 権限と画像の読み込み範囲

現行capabilityは `main` だけを対象にする。ボードのcapabilityを別に定義し、ダイアログ・ファイル操作・任意の窓作成の権限をまとめて渡さない。Rustのボード用コマンドでも呼び出し元の窓ラベルと編集セッションを照合する。capabilityの追加だけでは、カスタムコマンドのライブラリ誤配送は防げない。

現行 `allow_assets` は画像ルート・thumbsを許可し、DB・WAL・SHM・trashを禁止する。ただし許可はアプリ全体に追加され、切り替えで旧ルートが消えない。調べたTauri 2.12.5のScope APIには、追加したallowだけを撤回するAPIがない。旧ルートにforbidを追加すると、A→B→Aの再許可も妨げる。

ボードにパスを自由に指定させる方法は採らず、セッションと画像IDでRustへ要求し、現在のライブラリ内の生存画像だけを解決する方法を後続実装の候補にする。画像配信を独自プロトコルにする場合も、要求ごとにトークンと画像状態を確認する。正規化後のルート外、シンボリックリンクによる脱出、DB・trash・完全削除済み画像を返さない。既存のasset許可を残したまま「旧画像は読めない」とは説明しない。ギャラリーを含む読み込み経路の変更範囲をタスク2・12で決め、拒否とAへの再接続の両方を人工データで検査する。

この実証はasset protocolもファイル読取権限も有効にしていない。人工画像の表示とネイティブ動作の確認に限定した。

## phase2-checkとの対応

準備の隔離と実行環境、Eの閉じる・終了の成功と失敗、Fの別アプリとの固定とウインドウ全体の不透明度に対する先行実証。製品の通し確認欄にはチェックを付けない。本体のボード保存、ON/OFF設定、製品ダイアログ、2ライブラリの往復、画面補正は未実装であり、対応する後続タスクで改めて検証する。利用者はマージ前に上の再実行手順でネイティブ表示と終了中止を確認する。

本体の画面・文言は変えていないため、user-guideとドキュメント用スクリーンショットは変更しない。

## 検査結果

コミット前の本体の検査は `npm run lint`、`npm test`（41件）、`npm run build`、`src-tauri/` で `cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`（183件）が通った。独立実証も `cargo fmt --check`、`cargo clippy --offline -- -D warnings` が通り、上の証跡検査もPASS。Pythonの証跡検査スクリプトは `uvx ruff@0.17.3 check --isolated` で検査した。本体のUI・Rust・DBは変更しておらず、モックe2eと移動手順のモデル検査は実施対象外。

## 参照

- [NSWindow.alphaValue](https://developer.apple.com/documentation/appkit/nswindow/alphavalue?language=objc)
- [Tauri RunEvent](https://docs.rs/tauri/2.12.5/tauri/enum.RunEvent.html)
- [TauriのmacOS終了に関する報告](https://github.com/tauri-apps/tauri/issues/13778)。採否は報告だけで決めず、上の実機結果とインストール済みソースで確認した
