import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { dateTime } from './dateTime'
import type { Inspected, Settings } from './galleryTypes'
import ConfirmDialog from './ConfirmDialog'
import type { Backfill, BackfillCounts, FeaturesStatus, MissingModels, ModelFetch } from './importTypes'
import Status from './Status'
import Switch from './Switch'
import { Progress } from './StatusbarResult'
import './SkipDialog.css'
import './SettingsPage.css'

// Finder と同じく 1MB = 1000000 バイトで数える
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

const backfillSummary = (c: BackfillCounts) =>
  `${c.cancelled ? '中断しました。' : ''}補完 ${c.filled}枚、記録なし ${c.none}枚、読み取り失敗 ${c.failed}枚、対象外 ${c.excluded}枚`

// 設定のページ（8章、NFR-07）。一覧の場所に重ねて出し、サイドバーは残す。サムネイルの大きさは一覧のスライダーの値を覚えるので、ここには置かない
export default function SettingsPage({
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
  onRestore,
}: {
  root: string
  settings: Settings
  onSettings: (next: Partial<Settings>) => void
  // 元URLの補完（FR-208）。補完はギャラリーが持つので、ページを閉じても続き、開き直すと進み具合を出す
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
  // 管理情報を戻す（FR-107）。失敗したら理由の文字列で reject する。成功するとギャラリーごと作り直す
  onRestore: (path: string) => Promise<void>
}) {
  const ref = useRef<HTMLHeadingElement>(null)
  const [backup, setBackup] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  // 戻す前の確認で答えを待っている管理情報
  const [restoring, setRestoring] = useState<{ path: string; info: Inspected } | null>(null)
  // ON にする前の確認に出すモデルの大きさ。null は確認を出していない
  const [modelSize, setModelSize] = useState<number | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  // 欠けているモデル。3a から更新した利用者は、ON のままポーズのモデルだけがない（NFR-08）
  const [missing, setMissing] = useState<MissingModels | null>(null)
  const fetching = modelFetch?.running ?? false
  // 開いたら見出しへフォーカスを移す。下の一覧は操作を受けないので、キーボードでページから始められるようにする
  useEffect(() => ref.current?.focus(), [])
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
      setBackup({ kind: 'success', message: `${path} にエクスポートしました` })
    } catch (e) {
      setBackup({ kind: 'error', message: String(e) })
    }
  }

  async function pickRestore() {
    const path = await open({
      title: 'インポートする管理情報を選ぶ',
      filters: [{ name: 'SQLite', extensions: ['db'] }],
    })
    if (!path) return
    setBackup(null)
    try {
      setRestoring({ path, info: await invoke<Inspected>('inspect_backup', { path }) })
    } catch (e) {
      setBackup({ kind: 'error', message: String(e) })
    }
  }

  async function restore(path: string) {
    setRestoring(null)
    try {
      await onRestore(path)
    } catch (e) {
      setBackup({ kind: 'error', message: String(e) })
    }
  }

  return (
    <>
      <section className="gallery__settings" aria-labelledby="settings-title">
        <div className="settings__inner">
          <h2 id="settings-title" ref={ref} tabIndex={-1} className="settings__title">
            設定
          </h2>
          <p className="settings__lead">
            どのライブラリを開いても同じ設定を使います。バックアップは、開いているライブラリの管理情報が対象です。
          </p>

          <Group title="一般">
            <Row
              name="サイドバーでカテゴリを移すときに確認する"
              description="カテゴリをドラッグして移す前に、確認を出します。"
              control={
                <Switch
                  label="サイドバーでカテゴリを移すときに確認する"
                  checked={settings.confirm_category_move}
                  onChange={(confirm_category_move) => onSettings({ confirm_category_move })}
                />
              }
            />
          </Group>

          <Group title="アイデアボード">
            <Row
              name="アイデアボードを使う"
              description="オフにするとボタンとメニューが消え、開いているボードは閉じます。作ったボードは消えません。"
              control={
                <Switch
                  label="アイデアボードを使う"
                  checked={settings.board_enabled}
                  onChange={(board_enabled) => onSettings({ board_enabled })}
                />
              }
            />
          </Group>

          <Group title="類似画像検索">
            <Row
              name="類似画像検索を使う"
              description="オンにすると、初回だけモデルをダウンロードします。オフにしても、ダウンロードしたモデルと計算した結果は消えません。"
              control={
                <Switch
                  label="類似画像検索を使う"
                  checked={settings.similarity_enabled}
                  disabled={modelFetch?.running}
                  onChange={(on) => (on ? askSimilarity() : onSettings({ similarity_enabled: false }))}
                />
              }
            >
              {modelFetch?.running && (
                <p className="settings__status" role="status">
                  {modelFetch.progress
                    ? `モデルをダウンロード中 ${mb(modelFetch.progress.done)} / ${mb(modelFetch.progress.total)}`
                    : 'モデルを確認中…'}
                  <Progress
                    label="モデルをダウンロードする進み具合"
                    value={modelFetch.progress ?? { done: 0, total: 0 }}
                  />
                </p>
              )}
              {modelFetch?.error && <Status kind="error">{modelFetch.error}</Status>}
              {sizeError && <Status kind="error">{sizeError}</Status>}
            </Row>
            {modelFetch?.error && (
              <Row
                name="ダウンロードをやり直す"
                description="通信できるか確かめてから、もう一度ダウンロードします。"
                control={
                  <button type="button" className="button settings__button" onClick={onFetchModels}>
                    再試行
                  </button>
                }
              />
            )}
            <Row name="使うモデル">
              <dl className="settings__models">
                <dt>内容</dt>
                <dd>SigLIP 2（Google、Apache License 2.0）</dd>
                <dt>体の姿勢</dt>
                <dd>
                  YOLOX-tiny と RTMPose-m（OpenMMLab）。Kura は配布せず、OpenMMLab
                  の配布先から直接取得します。重みのライセンスの表記はなく、学習データには非商用・研究用の条件が付いたものが含まれます。
                </dd>
              </dl>
            </Row>
            {settings.similarity_enabled && missing?.aspects.includes('pose') && (
              <Row
                name="ポーズのモデル"
                description={`「体の姿勢」で比べるには、ポーズのモデル（約${mb(missing.size)}）が必要です。OpenMMLab が公開しているモデルを、アプリのデータフォルダへダウンロードします。`}
                control={
                  !modelFetch && (
                    <button type="button" className="button settings__button" onClick={onFetchModels}>
                      ダウンロード
                    </button>
                  )
                }
              />
            )}
            {settings.similarity_enabled && (
              <Row
                name="特徴量の計算"
                description={`計算済み ${features.done}枚、残り ${features.total - features.done - features.failed}枚、計算できなかった ${features.failed}枚${features.running ? '（計算中）' : ''}。「再計算」を押すと、計算できなかった画像と残りの画像をもう一度計算します。計算済みの結果は消えません。`}
                control={
                  <button
                    type="button"
                    className="button settings__button"
                    onClick={() => invoke('retry_features').catch((e) => console.error(e))}
                  >
                    再計算
                  </button>
                }
              >
                {features.error && <Status kind="error">{features.error}</Status>}
              </Row>
            )}
          </Group>

          <Group title="元URL">
            <Row
              name="元URLを補完"
              description="元URLがまだない画像について、ブラウザが残したダウンロード元の記録を読み、元URLとして登録します。読むのはライブラリの中のファイルだけです。登録済みの元URLは変えません。"
              control={
                <span className="settings__buttons">
                  <button
                    type="button"
                    className="button settings__button"
                    disabled={busy || backfill?.running}
                    onClick={onBackfill}
                  >
                    元URLを補完
                  </button>
                  {backfill?.running && (
                    <button type="button" className="button settings__button" onClick={onCancelBackfill}>
                      中断
                    </button>
                  )}
                </span>
              }
            >
              {busy && !backfill?.running && (
                <p className="settings__status">取り込みか Finder での変更の反映が終わってから補完できます。</p>
              )}
              {backfill?.running && (
                <p className="settings__status" role="status">
                  {backfill.counts
                    ? `補完中 ${backfill.counts.done} / ${backfill.counts.total}枚`
                    : '補完する画像を確認中…'}
                  <Progress label="元URLを補完する進み具合" value={backfill.counts ?? { done: 0, total: 0 }} />
                </p>
              )}
              {backfill && !backfill.running && backfill.counts && (
                <Status kind={backfill.counts.cancelled ? 'info' : 'success'}>
                  {backfillSummary(backfill.counts)}
                </Status>
              )}
              {backfill?.error && <Status kind="error">{backfill.error}</Status>}
            </Row>
          </Group>

          <Group title="バックアップ">
            <Row
              name="エクスポート"
              description="ライブラリの管理情報（カテゴリ、タグ、メモなど）を1つのファイルに書き出します。画像ファイルは含みません。"
              control={
                <button type="button" className="button settings__button" onClick={exportDb}>
                  管理情報をエクスポート…
                </button>
              }
            />
            <Row
              name="インポート"
              description="エクスポートしたファイルで、今の管理情報を置き換えます。その時点の管理情報に戻せます。"
              control={
                <button type="button" className="button settings__button" onClick={pickRestore}>
                  管理情報をインポート…
                </button>
              }
            >
              {backup && <Status kind={backup.kind}>{backup.message}</Status>}
            </Row>
          </Group>
        </div>
      </section>
      {restoring && (
        <ConfirmDialog
          title="管理情報をインポート"
          confirm="インポート"
          onConfirm={() => restore(restoring.path)}
          onClose={() => setRestoring(null)}
        >
          {restoring.info.other_library && (
            <Status kind="warning">
              {`別のライブラリの管理情報かもしれません。選んだ管理情報の画像のうち、このライブラリに見つかるのは${restoring.info.found}枚だけです`}
            </Status>
          )}
          {dateTime(restoring.info.exported_at)} にエクスポートした管理情報（{restoring.info.images}
          枚）で、今の管理情報（{restoring.info.current}
          枚）を置き換えます。今の管理情報の写しを、ライブラリの .kura/backups に残します。画像ファイルは変えません。
        </ConfirmDialog>
      )}
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

// 意味のまとまり。見出しと、行を囲む枠（docs/design.md「設定のページ」）
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings__group" aria-labelledby={id}>
      <h3 id={id} className="settings__group-title">
        {title}
      </h3>
      <div className="settings__card">{children}</div>
    </section>
  )
}

// 枠の中の1行。左に名前と説明、右にスイッチかボタン。進み具合やエラーは説明の下に出す
function Row({
  name,
  description,
  control,
  children,
}: {
  name: string
  description?: string
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="settings__row">
      <div className="settings__text">
        <span className="settings__name">{name}</span>
        {description && <span className="settings__description">{description}</span>}
        {children}
      </div>
      {control && <div className="settings__control">{control}</div>}
    </div>
  )
}
