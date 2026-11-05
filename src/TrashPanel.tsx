import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

// ゴミ箱を開いている間に、詳細パネルの場所に出す（FR-511）
export default function TrashPanel({
  count,
  selected,
  onRestore,
  onEmpty,
}: {
  // ゴミ箱の画像の枚数
  count: number
  // 選んでいる画像の枚数
  selected: number
  onRestore: () => void
  onEmpty: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <aside className="gallery__detail" aria-label="ゴミ箱">
      <h2 className="detail__name">{selected ? `${selected}枚を選んでいます` : 'ゴミ箱'}</h2>
      <p className="detail__note">
        削除した画像は、ゴミ箱を空にするまで元に戻せます。元のカテゴリが削除されていれば、未分類に戻します。
      </p>
      <div className="detail__actions">
        <button type="button" className="button" disabled={!selected} onClick={onRestore}>
          元に戻す
        </button>
        <button type="button" className="button" disabled={!count} onClick={() => setConfirming(true)}>
          ゴミ箱を空にする
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="ゴミ箱を空にする"
          confirm="空にする"
          onConfirm={() => {
            setConfirming(false)
            onEmpty()
          }}
          onClose={() => setConfirming(false)}
        >
          ゴミ箱の画像 {count}枚を完全に削除します。元に戻せません。
        </ConfirmDialog>
      )}
    </aside>
  )
}
