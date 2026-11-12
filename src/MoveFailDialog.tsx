import { useEffect, useRef } from 'react'
import Status, { type StatusKind } from './Status'
import './SkipDialog.css'

// カテゴリを変えたときやゴミ箱の操作で移せなかった画像の一覧（FR-407、FR-511）。見た目は取り込みのスキップの一覧に合わせる。
// 元URLの注意（FR-208）の一覧にも使い、そのときは kind を warning にする
export default function MoveFailDialog({
  title = '移せなかった画像',
  kind = 'error',
  failed,
  onClose,
}: {
  title?: string
  kind?: StatusKind
  failed: { file_name: string; message: string }[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="move-fail-title" onClose={onClose}>
      <h2 id="move-fail-title" className="dialog__title">
        {title}（{failed.length}枚）
      </h2>
      <ul className="skip__list">
        {failed.map((f, i) => (
          <li key={i} className="skip__item">
            <span className="skip__name">{f.file_name}</span>
            <Status kind={kind}>{f.message}</Status>
          </li>
        ))}
      </ul>
      <form method="dialog" className="dialog__actions">
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
