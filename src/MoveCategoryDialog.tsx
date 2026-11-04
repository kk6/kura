import { useEffect, useRef, useState } from 'react'
import './SkipDialog.css'

// カテゴリをドラッグで移す前の確認（FR-412）。元に戻す操作がないので、意図しない場所に落としたときに止められるようにする
export default function MoveCategoryDialog({
  name,
  to,
  onConfirm,
  onClose,
}: {
  name: string
  to: string
  onConfirm: (skipNextTime: boolean) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const [skip, setSkip] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
    // WebKit は autoFocus を無視して先頭のチェックボックスを選ぶので、Enter で移せるよう明示的に選ぶ
    confirm.current?.focus()
  }, [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="move-category-title" onClose={onClose}>
      <h2 id="move-category-title" className="dialog__title">
        カテゴリを移す
      </h2>
      <p>
        「{name}」を{to}へ移します。フォルダも中の画像ごと移ります。
      </p>
      <label className="dialog__check">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        今後は確認しない
      </label>
      <form method="dialog" className="dialog__actions">
        <button className="button">キャンセル</button>
        <button
          ref={confirm}
          className="button"
          onClick={(e) => {
            e.preventDefault()
            onConfirm(skip)
          }}
        >
          移す
        </button>
      </form>
    </dialog>
  )
}
