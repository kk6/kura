import Status from './Status'
import type { ImportProgress, Report, ScanReport, Skipped } from './importTypes'

// ステータスバーに出す一括操作の結果
export type Failed = { file_name: string; message: string }[]
export type Result =
  | { kind: 'report'; report: Report }
  // 差分検出（FR-104）
  | { kind: 'scan'; report: ScanReport }
  | { kind: 'error'; message: string; failed?: Failed }
  | { kind: 'deleted'; name: string; moved: number }
  | { kind: 'assigned'; moved: number; failed: Failed }
  // ゴミ箱（FR-511）。uncategorized は元のカテゴリがなく未分類へ戻した枚数
  | { kind: 'trashed'; count: number; failed: Failed }
  | { kind: 'emptied'; count: number; failed: Failed }
  | { kind: 'forgotten'; count: number; failed: Failed }
  | { kind: 'restored'; count: number; uncategorized: number; failed: Failed }

type Props = {
  // 差分検出と取り込みの進み具合。どちらかがあれば、結果ではなく進み具合を出す
  scanning: ImportProgress | null
  progress: ImportProgress | null
  result: Result | null
  // 移せなかった画像かスキップしたファイルの一覧を開く
  onShowFailed: () => void
  onShowMissing: () => void
}

export default function StatusbarResult({ scanning, progress, result, onShowFailed, onShowMissing }: Props) {
  return (
    <span className="statusbar__import" role="status">
      <Content
        scanning={scanning}
        progress={progress}
        result={result}
        onShowFailed={onShowFailed}
        onShowMissing={onShowMissing}
      />
    </span>
  )
}

function Content({ scanning, progress, result, onShowFailed, onShowMissing }: Props) {
  const now = scanning ?? progress
  if (now) {
    return (
      <>
        {scanning
          ? scanning.total
            ? `Finder での変更を反映中 ${scanning.done} / ${scanning.total}枚`
            : 'Finder での変更を確認中…'
          : `取り込み中 ${now.done} / ${now.total}枚`}
        <Progress label={scanning ? 'Finder での変更を反映する進み具合' : '取り込みの進み具合'} value={now} />
      </>
    )
  }
  if (!result) return null
  const failedLink = (label: string, failed: Failed | undefined) =>
    !!failed?.length && (
      <button type="button" className="statusbar__link" onClick={onShowFailed}>
        <Status kind="error">
          {label} {failed.length}枚
        </Status>
      </button>
    )
  switch (result.kind) {
    case 'error':
      return (
        <>
          <Status kind="error">{result.message}</Status>
          {failedLink('移せない', result.failed)}
        </>
      )
    case 'deleted':
      return (
        <Status kind="success">
          「{result.name}」を削除。未分類へ {result.moved}枚
        </Status>
      )
    case 'assigned':
      return (
        <>
          <Status kind="success">カテゴリを変更 {result.moved}枚</Status>
          {failedLink('移せない', result.failed)}
        </>
      )
    case 'scan':
      return (
        <>
          <Status kind="success">{scanSummary(result.report)}</Status>
          {result.report.missing > 0 && (
            <button type="button" className="statusbar__link" onClick={onShowMissing}>
              <Status kind="warning">見つからない画像 {result.report.missing}枚</Status>
            </button>
          )}
          <SkippedLinks skipped={result.report.skipped} errorLabel="登録できない" onShow={onShowFailed} />
        </>
      )
    case 'report':
      return (
        <>
          <Status kind="success">取り込み {result.report.added}枚</Status>
          {result.report.moved > 0 && <Status kind="success">未分類から移した {result.report.moved}枚</Status>}
          <SkippedLinks skipped={result.report.skipped} errorLabel="取り込めない" onShow={onShowFailed} />
        </>
      )
    default:
      return (
        <>
          <Status kind="success">
            {TRASH_DONE[result.kind]} {result.count}枚
          </Status>
          {result.kind === 'restored' && result.uncategorized > 0 && (
            <Status kind="info">元のカテゴリがないため未分類に戻した {result.uncategorized}枚</Status>
          )}
          {failedLink(
            result.kind === 'emptied' ? '削除できない' : result.kind === 'forgotten' ? '外せない' : '移せない',
            result.failed,
          )}
        </>
      )
  }
}

// スキップ（重複と対応していない形式）とエラーを分けて数える
function SkippedLinks({ skipped, errorLabel, onShow }: { skipped: Skipped[]; errorLabel: string; onShow: () => void }) {
  const errors = skipped.filter((s) => s.kind === 'error').length
  return (
    <>
      {skipped.length > errors && (
        <button type="button" className="statusbar__link" onClick={onShow}>
          <Status kind="warning">スキップ {skipped.length - errors}枚</Status>
        </button>
      )}
      {errors > 0 && (
        <button type="button" className="statusbar__link" onClick={onShow}>
          <Status kind="error">
            {errorLabel} {errors}件
          </Status>
        </button>
      )}
    </>
  )
}

const TRASH_DONE = {
  trashed: 'ゴミ箱へ移した',
  restored: '元に戻した',
  emptied: 'ゴミ箱から削除した',
  forgotten: 'DBから外した',
}

// 差分検出の結果のうち、0でないものだけを並べる
function scanSummary(r: ScanReport) {
  const parts = [
    ['登録', r.added, '枚'],
    ['移動', r.moved, '枚'],
    ['更新', r.updated, '枚'],
    ['見つかった', r.returned, '枚'],
    ['カテゴリ追加', r.categories_added, '件'],
    ['カテゴリ削除', r.categories_removed, '件'],
  ]
    .filter(([, n]) => n)
    .map(([label, n, unit]) => `${label} ${n}${unit}`)
  return parts.length ? `差分を反映（${parts.join('、')}）` : 'Finder での変更はありません'
}

// 数え終わるまで（total が0の間）は、バーを空のまま出す
const Progress = ({ label, value }: { label: string; value: ImportProgress }) => (
  <span
    className="progress"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={value.total}
    aria-valuenow={value.done}
  >
    <span className="progress__done" style={{ width: `${value.total ? (value.done / value.total) * 100 : 0}%` }} />
  </span>
)
