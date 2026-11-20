# ADR（設計判断の記録）

Kura の設計判断と、その理由、比べて却下した案を残す。`docs/requirements.md` には何をするかだけを書き、理由はここへリンクする。書き方は利用者の `intent` スキルに従う。

ADR は、後から知らないと危ない判断にだけ書く。データの保全、互換性、外部への通信、戻すのに手間がかかる設計がこれにあたる。理由を知らずにコードを簡単にすると、画像を失ったり、移行をやり直したりするおそれがある判断である。

操作と表示（キー、選び方、並べ方、文言、配置）の判断は ADR にしない。使ってみて変える前提のため、利用者の指示をそのまま決定とし、`docs/requirements.md` と `docs/user-guide.md` だけを直す。

受理した ADR は書き換えない。判断を変えるときは、新しい ADR で上書きする。操作と表示の判断を書いた ADR は、上書きせずに消してよい（0012、0024、0030 はこの決まりで消した。経緯は git の履歴にある）。

| ADR | 判断 |
| --- | --- |
| [0001](0001-desktop-app-with-tauri.md) | ブラウザで開くウェブアプリではなく、デスクトップアプリにする |
| [0002](0002-ml-worker-onedir-bundle.md) | 機械学習の処理を別プロセスのワーカーにし、onedir の形で同梱する |
| [0003](0003-start-worker-on-demand.md) | ワーカーは計算する画像があるときだけ起動し、落ちても自動で起動し直さない |
| [0004](0004-own-virtual-masonry.md) | 一覧の仮想スクロールを自前で作る |
| [0005](0005-crash-safe-file-move.md) | ファイルを動かす操作は、予定を記録してから3段階で行う |
| [0006](0006-no-relative-path-in-db.md) | カテゴリとフォルダを1対1にし、DB に画像のパスを持たない |
| [0007](0007-diff-detection-without-watching.md) | Finder での変更は常時監視せず、差分検出で反映する |
| [0008](0008-minimal-library-switching.md) | 複数のライブラリの切り替えを最小限で足す |
| [0009](0009-download-source-instead-of-url-import.md) | URL からの取り込みを保留し、ダウンロード元の記録を読んで元URLにする |
| [0010](0010-move-unsorted-duplicates.md) | 未分類にある重複画像は、スキップせずに取り込み先のカテゴリへ移す |
| [0011](0011-delete-only-through-trash.md) | 画像の完全削除は、ゴミ箱を通してだけ行う |
| [0013](0013-filter-by-registered-date.md) | 追加した日での絞り込みには、登録日時を使う |
| [0014](0014-hide-mark-as-image-column.md) | 人に見られたくない画像の印は、タグで代用せずに画像ごとに持つ |
| [0015](0015-filter-and-sort-in-ui.md) | 一覧の並べ替えと絞り込みを画面側で行う |
| [0016](0016-siglip2-for-content.md) | 類似画像検索の内容の観点に SigLIP 2 を使い、全件比較で検索する |
| [0017](0017-composition-without-learned-model.md) | 構図の観点は、学習済みモデルを使わない特徴量で作る |
| [0018](0018-features-from-thumbnails-single-thread.md) | 特徴量はサムネイルから、1スレッドで計算する |
| [0019](0019-rtmpose-m-for-pose.md) | ポーズの骨格推定に RTMPose-m を使い、反転したポーズを同じとみなす |
| [0020](0020-download-models-on-demand.md) | モデルは同梱せず、利用者が類似画像検索を ON にしたときにダウンロードする |
| [0021](0021-separate-features-db.md) | 特徴量を `features.db` に分け、計算し直せるものとして扱う |
| [0022](0022-normalize-similarity-per-aspect.md) | 観点ごとの類似度を平均0・標準偏差1にそろえてから重みを掛ける |
| [0023](0023-idea-board-as-optional-feature.md) | アイデアボードを、本体に同梱する任意の機能にする |
| [0025](0025-one-kind-per-library.md) | 画像以外の資料は、種類ごとに別のライブラリで管理する |
| [0026](0026-exclusive-db-and-reconnect.md) | ライブラリの DB を排他モードで開き、ディスクの I/O エラーでは開き直す |
| [0027](0027-backup-before-migration.md) | DB を移行する前に、移行前の `kura.db` の写しを残す |
| [0028](0028-two-settings-locations.md) | 設定を、アプリ全体の設定とライブラリの DB の2か所に分ける |
| [0029](0029-auto-tagging-as-suggestions.md) | 自動のタグ付けは、推定したタグを候補として出し、承認したものだけを付ける |
| [0031](0031-backup-export-only.md) | DB のバックアップは書き出しだけを作り、戻す操作は作らない |
