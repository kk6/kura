import { useEffect, useRef, useState } from 'react'
import { CategorySelect } from './Classify'
import { subtree } from './categoryTree'
import type { Category } from './galleryTypes'
import './SkipDialog.css'
import './Classify.css'
import './CategoryDialog.css'

// サイドバーの右クリックの「統合…」（FR-417）。統合先を詳細パネルと同じ欄で選び、移す枚数と子カテゴリの数を見せて確かめる
export default function MergeCategoryDialog({
  id,
  categories,
  images,
  onConfirm,
  onClose,
}: {
  id: number
  categories: Category[]
  // 統合元と子孫のカテゴリにある画像の枚数
  images: number
  onConfirm: (into: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [into, setInto] = useState<number | null>(null)
  useEffect(() => ref.current?.showModal(), [])
  const gone = subtree(categories, id)
  const name = categories.find((c) => c.id === id)?.name
  // 統合先には、元のカテゴリ自身とその子孫は選べない。子孫は丸ごと外れるので、残りの道筋は変わらない
  const choices = categories.filter((c) => !gone.has(c.id))
  const target = choices.find((c) => c.id === into)?.name

  return (
    <dialog ref={ref} className="dialog category-dialog" aria-labelledby="merge-category-title" onClose={onClose}>
      <h2 id="merge-category-title" className="dialog__title">
        「{name}」を統合する
      </h2>
      <div className="category-dialog__field">
        <label htmlFor="merge-category-select">統合先</label>
        <CategorySelect
          id="merge-category-select"
          selected={[{ id, category_id: into }]}
          categories={choices}
          uncategorized={false}
          onAssign={async (_, c) => setInto(c)}
        />
      </div>
      {target && (
        <p className="category-dialog__note">
          画像 {images}枚{gone.size > 1 && `と子カテゴリ ${gone.size - 1}個`}を「{target}
          」へ移し、「{name}」を削除します。同じ名前の子カテゴリは中身をまとめ、同じ名前のファイルには番号を付けます。
        </p>
      )}
      <form method="dialog" className="dialog__actions">
        <button className="button">キャンセル</button>
        <button
          className="button button--primary"
          disabled={into === null}
          onClick={(e) => {
            e.preventDefault()
            if (into !== null) onConfirm(into)
          }}
        >
          統合する
        </button>
      </form>
    </dialog>
  )
}
