import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { useEffect, useRef, useState } from 'react'
import type { Settings } from './galleryTypes'
import ConfirmDialog from './ConfirmDialog'
import type { Backfill, BackfillCounts, FeaturesStatus, MissingModels, ModelFetch } from './importTypes'
import Status from './Status'
import { Progress } from './StatusbarResult'
import './SkipDialog.css'

// Finder と同じく 1MB = 1000000 バイトで数える
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

const backfillSummary = (c: BackfillCounts) =>
  `${c.cancelled ? '中断しました。' : ''}補完 ${c.filled}枚、記録なし ${c.none}枚、読み取り失敗 ${c.failed}枚、対象外 ${c.excluded}枚`

// 設定ダイアログ（NFR-07）。サムネイルの大きさは一覧のスライダーの値を覚えるので、ここには置かない
export default function SettingsDialog({
  root,
  settings,
  onSettings,
  backfill,
  busy,
  onBackfill,
  onCancelBackfill,
  modelFetch,
  onFetchModels,
  features,
  onClose,
}: {
  root: string
  settings: Settings
  onSettings: (next: Partial<Settings>) => void
  // 元URLの補完（FR-208）。補完はギャラリーが持つので、ダイアログを閉じても続き、開き直すと進み具合を出す
  backfill: Backfill | null
  // 取り込みか差分検出の途中。その間は補完を始められない
  busy: boolean
  onBackfill: () => void
  onCancelBackfill: () => void
  // 類似画像検索のモデルのダウンロード（NFR-08）。終わると Gallery が similarity_enabled を保存する
  modelFetch: ModelFetch | null
  onFetchModels: () => void
  // 特徴量の計算の状況（FR-604）
  features: FeaturesStatus
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [backup, setBackup] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  // ON にする前の確認に出すモデルの大きさ。null は確認を出していない
  const [modelSize, setModelSize] = useState<number | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  // 欠けているモデル。3a から更新した利用者は、ON のままポーズのモデルだけがない（NFR-08）
  const [missing, setMissing] = useState<MissingModels | null>(null)
  const fetching = modelFetch?.running ?? false
  useEffect(() => ref.current?.showModal(), [])
  // 開いたときと、ダウンロードが終わったときに読み直す。通信しない
  useEffect(() => {
    if (fetching) return
    invoke<MissingModels>('missing_models')
      .then(setMissing)
      .catch((e) => console.error(e))
  }, [fetching, settings.similarity_enabled])

  // 押すまで通信しない（NFR-08）。大きさは同梱した model.json から読むだけ
  async function askSimilarity() {
    setSizeError(null)
    try {
      setModelSize(await invoke<number>('model_size'))
    } catch (e) {
      setSizeError(String(e))
    }
  }

  async function exportDb() {
    const name = root.split('/').pop()
    const date = new Date().toLocaleDateString('sv') // YYYY-MM-DD
    const path = await save({ defaultPath: `${name}-${date}.db`, filters: [{ name: 'SQLite', extensions: ['db'] }] })
    if (!path) return
    try {
      await invoke('backup_library', { path })
      setBackup({ kind: 'success', message: `${path} に書き出しました` })
    } catch (e) {
      setBackup({ kind: 'error', message: String(e) })
    }
  }

  return (
    <>
      <dialog ref={ref} className="dialog" aria-labelledby="settings-title" onClose={onClose}>
        <h2 id="settings-title" className="dialog__title">
          設定
        </h2>
        <label className="dialog__check">
          <input
            type="checkbox"
            checked={settings.confirm_category_move}
            onChange={(e) => onSettings({ confirm_category_move: e.target.checked })}
          />
          サイドバーでカテゴリを移すときに確認する
        </label>
        <h3 className="dialog__section">アイデアボード</h3>
        <label className="dialog__check">
          <input
            type="checkbox"
            checked={settings.board_enabled}
            onChange={(e) => onSettings({ board_enabled: e.target.checked })}
          />
          アイデアボードを使う
        </label>
        <p>オフにするとボタンとメニューが消え、開いているボードは閉じます。作ったボードは消えません。</p>
        <h3 className="dialog__section">類似画像検索</h3>
        <label className="dialog__check">
          <input
            type="checkbox"
            checked={settings.similarity_enabled}
            disabled={modelFetch?.running}
            onChange={(e) => (e.target.checked ? askSimilarity() : onSettings({ similarity_enabled: false }))}
          />
          類似画像検索を使う
        </label>
        <p>
          オンにすると、初回だけモデルをダウンロードします。オフにしても、ダウンロードしたモデルと計算した結果は消えません。
        </p>
        <p>モデル：SigLIP 2（Google、Apache License 2.0）</p>
        <p>
          ポーズのモデル：YOLOX-tiny と RTMPose-m（OpenMMLab）。Kura は配布せず、OpenMMLab
          の配布先から直接取得します。重みのライセンスの表記はなく、学習データには非商用・研究用の条件が付いたものが含まれます。
        </p>
        {settings.similarity_enabled && missing?.aspects.includes('pose') && (
          <>
            <p>
              「体の姿勢」で比べるには、ポーズのモデル（約{mb(missing.size)}）が必要です。OpenMMLab
              が公開しているモデルを、アプリのデータフォルダへダウンロードします。
            </p>
            {!modelFetch && (
              <div>
                <button type="button" className="button" onClick={onFetchModels}>
                  ダウンロード
                </button>
              </div>
            )}
          </>
        )}
        {modelFetch?.running && (
          <p className="dialog__row" role="status">
            {modelFetch.progress
              ? `モデルをダウンロード中 ${mb(modelFetch.progress.done)} / ${mb(modelFetch.progress.total)}`
              : 'モデルを確認中…'}
            <Progress label="モデルをダウンロードする進み具合" value={modelFetch.progress ?? { done: 0, total: 0 }} />
          </p>
        )}
        {modelFetch?.error && (
          <>
            <Status kind="error">{modelFetch.error}</Status>
            <div>
              <button type="button" className="button" onClick={onFetchModels}>
                再試行
              </button>
            </div>
          </>
        )}
        {sizeError && <Status kind="error">{sizeError}</Status>}
        {settings.similarity_enabled && (
          <>
            <p>
              計算済み {features.done}枚、残り {features.total - features.done - features.failed}枚、計算できなかった{' '}
              {features.failed}枚{features.running && '（計算中）'}
            </p>
            {features.error && <Status kind="error">{features.error}</Status>}
            <p>
              「再計算」を押すと、計算できなかった画像と残りの画像をもう一度計算します。計算済みの結果は消えません。
            </p>
            <div>
              <button
                type="button"
                className="button"
                onClick={() => invoke('retry_features').catch((e) => console.error(e))}
              >
                再計算
              </button>
            </div>
          </>
        )}
        <h3 className="dialog__section">元URL</h3>
        <p>
          元URLがまだない画像について、ブラウザが残したダウンロード元の記録を読み、元URLとして登録します。読むのはライブラリの中のファイルだけです。登録済みの元URLは変えません。
        </p>
        <div className="dialog__row">
          <button type="button" className="button" disabled={busy || backfill?.running} onClick={onBackfill}>
            元URLを補完
          </button>
          {backfill?.running && (
            <button type="button" className="button" onClick={onCancelBackfill}>
              中断
            </button>
          )}
        </div>
        {busy && !backfill?.running && <p>取り込みか Finder での変更の反映が終わってから補完できます。</p>}
        {backfill?.running && (
          <p className="dialog__row" role="status">
            {backfill.counts ? `補完中 ${backfill.counts.done} / ${backfill.counts.total}枚` : '補完する画像を確認中…'}
            <Progress label="元URLを補完する進み具合" value={backfill.counts ?? { done: 0, total: 0 }} />
          </p>
        )}
        {backfill && !backfill.running && backfill.counts && (
          <Status kind={backfill.counts.cancelled ? 'info' : 'success'}>{backfillSummary(backfill.counts)}</Status>
        )}
        {backfill?.error && <Status kind="error">{backfill.error}</Status>}
        <h3 className="dialog__section">バックアップ</h3>
        <p>ライブラリの管理情報（カテゴリ、タグ、メモなど）を1つのファイルに書き出します。画像ファイルは含みません。</p>
        <div>
          <button type="button" className="button" onClick={exportDb}>
            管理情報を書き出す…
          </button>
        </div>
        {backup && <Status kind={backup.kind}>{backup.message}</Status>}
        <form method="dialog" className="dialog__actions">
          <button className="button">閉じる</button>
        </form>
      </dialog>
      {/* ダイアログの中に置くと、React が close をこのダイアログの onClose にも伝え、設定まで閉じる */}
      {modelSize !== null && (
        <ConfirmDialog
          title="類似画像検索を使う"
          confirm="ダウンロードして使う"
          onConfirm={() => {
            setModelSize(null)
            onFetchModels()
          }}
          onClose={() => setModelSize(null)}
        >
          類似画像検索に使うモデル（合わせて {mb(modelSize)}）を、アプリのデータフォルダへダウンロードします。SigLIP 2
          は Kura の GitHub Release から、ポーズのモデルは OpenMMLab
          の配布先から取得します。ダウンロード済みのモデルは取得し直しません。
        </ConfirmDialog>
      )}
    </>
  )
}
