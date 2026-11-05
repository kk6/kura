import { useEffect, useRef } from 'react'
import Status from './Status'
import type { Skipped } from './importTypes'
import './SkipDialog.css'

const REASON: Record<Skipped['kind'], string> = {
  duplicate: '同じ画像がライブラリ（ゴミ箱を含む）にあります',
  unsupported: '対応していない形式です',
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
  onClose,
}: {
  title?: string
  skipped: Skipped[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="skip-title" onClose={onClose}>
      <h2 id="skip-title" className="dialog__title">
        {title}（{skipped.length}件）
      </h2>
      <ul className="skip__list">
        {skipped.map((s) => {
          const { name, dir } = split(s.path)
          return (
            <li key={s.path} className="skip__item">
              <span className="skip__name">{name}</span>
              <span className="skip__dir">{dir}</span>
              <Status kind={s.kind === 'error' ? 'error' : 'warning'}>
                {REASON[s.kind]}
                {s.kind === 'error' && `（${s.message}）`}
              </Status>
            </li>
          )
        })}
      </ul>
      <form method="dialog" className="dialog__actions">
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
