import { useEffect, useRef } from 'react'
import './SkipDialog.css'

// カテゴリを削除する前の確認（FR-404）。取り消せない操作なので、消えるカテゴリの数と未分類へ移る画像の枚数を見せる
export default function DeleteCategoryDialog({
  name,
  categories,
  images,
  onConfirm,
  onClose,
}: {
  name: string
  // 削除するカテゴリ自身を含む数
  categories: number
  images: number
  onConfirm: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    // 取り消せない操作なので、Enter を押しただけでは削除しないようキャンセルを選んでおく
    cancel.current?.focus()
  }, [])

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="delete-category-title" onClose={onClose}>
      <h2 id="delete-category-title" className="dialog__title">
        カテゴリを削除する
      </h2>
      <p>
        「{name}」{categories > 1 && `と子カテゴリ ${categories - 1}個`}を削除します。中の画像 {images}枚は未分類へ移ります。画像は削除しません。
      </p>
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
          削除する
        </button>
      </form>
    </dialog>
  )
}
