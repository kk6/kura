import { useEffect, useRef, type ReactNode } from 'react'
import './SkipDialog.css'

// 取り消せない操作の前の確認。カテゴリの削除（FR-404）とゴミ箱を空にする（FR-511）で、何が消えるかを件数で見せる
export default function ConfirmDialog({
  title,
  confirm,
  children,
  onConfirm,
  onClose,
}: {
  title: string
  // 実行するボタンの文言
  confirm: string
  children: ReactNode
  onConfirm: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    // 取り消せない操作なので、Enter を押しただけでは実行しないようキャンセルを選んでおく
    cancel.current?.focus()
  }, [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="confirm-title" onClose={onClose}>
      <h2 id="confirm-title" className="dialog__title">
        {title}
      </h2>
      <p>{children}</p>
      <form method="dialog" className="dialog__actions">
        <button ref={cancel} className="button">
          キャンセル
        </button>
        <button
          className="button"
          onClick={(e) => {
            e.preventDefault()
            onConfirm()
          }}
        >
          {confirm}
        </button>
      </form>
    </dialog>
  )
}
