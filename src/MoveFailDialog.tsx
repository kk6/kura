import { useEffect, useRef } from 'react'
import Status from './Status'
import './SkipDialog.css'

// カテゴリを変えたときに移せなかった画像の一覧（FR-407）。見た目は取り込みのスキップの一覧に合わせる
export default function MoveFailDialog({
  failed,
  onClose,
}: {
  failed: { file_name: string; message: string }[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="move-fail-title" onClose={onClose}>
      <h2 id="move-fail-title" className="dialog__title">
        移せなかった画像（{failed.length}枚）
      </h2>
      <ul className="skip__list">
        {failed.map((f, i) => (
          <li key={i} className="skip__item">
            <span className="skip__name">{f.file_name}</span>
            <Status kind="error">{f.message}</Status>
          </li>
        ))}
      </ul>
      <form method="dialog" className="dialog__actions">
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
