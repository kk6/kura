import { useEffect, useRef, useState } from 'react'
import Status from './Status'
import type { Skipped } from './importTypes'
import './SkipDialog.css'

const REASON: Record<Skipped['kind'], string> = {
  duplicate: '同じ画像がライブラリ（ゴミ箱を含む）にあります',
  unsupported: '対応していない形式です',
  setAside: '対応していない形式なので、_未対応ファイル/ へ移しました',
  error: '取り込めませんでした',
}

const split = (path: string) => {
  const i = path.lastIndexOf('/')
  return { name: path.slice(i + 1), dir: path.slice(0, i) }
}

// shortcut: 一覧から既存の画像へ移る操作（FR-204）はまだない。一覧と選択を作るタスク#6・#7 で足す
export default function SkipDialog({
  title = '取り込まなかったファイル',
  skipped,
  canTidy,
  onTidy,
  onSetAside,
  onClose,
}: {
  title?: string
  skipped: Skipped[]
  // 差分検出の直後の一覧でだけ渡す（スキップの一覧は保存しないため）。
  // canTidy は「整理…」を出せる重複の行か（登録済みの画像がギャラリーにある）。FR-109
  canTidy?: (s: Skipped & { kind: 'duplicate' }) => boolean
  onTidy?: (s: Skipped & { kind: 'duplicate' }) => void
  // 対応していない形式のファイルをまとめて _未対応ファイル/ へ移す（FR-108）。失敗は行のエラーとして返ってくる
  onSetAside?: (paths: string[]) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  const [busy, setBusy] = useState(false)
  const unsupported = skipped.filter((s) => s.kind === 'unsupported').map((s) => s.path)
  const setAside = skipped.filter((s) => s.kind === 'setAside').length

  async function moveAll() {
    setBusy(true)
    try {
      await onSetAside!(unsupported)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="skip-title" onClose={onClose}>
      <h2 id="skip-title" className="dialog__title">
        {title}（{skipped.length}件）
      </h2>
      {setAside > 0 && (
        <p>
          <Status kind="success">_未対応ファイル/ へ移した {setAside}件</Status>
        </p>
      )}
      <ul className="skip__list">
        {skipped.map((s) => {
          const { name, dir } = split(s.path)
          return (
            <li key={s.path} className="skip__item">
              <span className="skip__name">{name}</span>
              <span className="skip__dir">{dir}</span>
              <span className="dialog__row">
                <Status kind={s.kind === 'error' ? 'error' : s.kind === 'setAside' ? 'success' : 'warning'}>
                  {REASON[s.kind]}
                  {s.kind === 'error' && `（${s.message}）`}
                </Status>
                {s.kind === 'duplicate' && onTidy && canTidy?.(s) && (
                  <button type="button" className="button skip__action" onClick={() => onTidy(s)}>
                    整理…
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <form method="dialog" className="dialog__actions">
        {onSetAside && unsupported.length > 0 && (
          <button type="button" className="button" disabled={busy} onClick={moveAll}>
            対応していない形式のファイルを _未対応ファイル/ へ移す（{unsupported.length}件）
          </button>
        )}
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
