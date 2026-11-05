import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

// ゴミ箱を開いている間に、詳細パネルの場所に出す（FR-511）
export default function TrashPanel({
  count,
  selected,
  name,
  onRestore,
  onPurge,
  onEmpty,
}: {
  // ゴミ箱の画像の枚数
  count: number
  // 選んでいる画像の枚数
  selected: number
  // 1枚だけ選んでいるときのファイル名
  name?: string
  onRestore: () => void
  // 選んだ画像だけを完全に削除する
  onPurge: () => void
  onEmpty: () => void
}) {
  // 確認ダイアログで答えを待っている操作
  const [confirming, setConfirming] = useState<'purge' | 'empty' | null>(null)
  return (
    <aside className="gallery__detail" aria-label="ゴミ箱">
      <h2 className="detail__name">{name ?? (selected ? `${selected}枚を選んでいます` : 'ゴミ箱')}</h2>
      <p className="detail__note">
        削除した画像は、ゴミ箱を空にするまで元に戻せます。元のカテゴリが削除されていれば、未分類に戻します。
      </p>
      <div className="detail__actions">
        <button type="button" className="button" disabled={!selected} onClick={onRestore}>
          元に戻す
        </button>
        <button type="button" className="button" disabled={!selected} onClick={() => setConfirming('purge')}>
          完全に削除
        </button>
        <button type="button" className="button" disabled={!count} onClick={() => setConfirming('empty')}>
          ゴミ箱を空にする
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={confirming === 'purge' ? '選んだ画像を完全に削除する' : 'ゴミ箱を空にする'}
          confirm={confirming === 'purge' ? '削除する' : '空にする'}
          onConfirm={() => {
            setConfirming(null)
            if (confirming === 'purge') onPurge()
            else onEmpty()
          }}
          onClose={() => setConfirming(null)}
        >
          {confirming === 'purge' ? `選んだ画像 ${selected}枚` : `ゴミ箱の画像 ${count}枚`}
          を完全に削除します。元に戻せません。
        </ConfirmDialog>
      )}
    </aside>
  )
}
