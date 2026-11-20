import { Icon, ICONS } from './icons'
import './Detail.css'

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
  // 選んだ画像だけを完全に削除する確認と、ゴミ箱を空にする確認を出す。確認は右クリックからも出すので、Gallery が持つ
  onPurge: () => void
  onEmpty: () => void
}) {
  return (
    <aside className="gallery__detail" aria-label="ゴミ箱">
      <h2 className="detail__name">{name ?? (selected ? `${selected}枚を選んでいます` : 'ゴミ箱')}</h2>
      <p className="detail__note">
        削除した画像は、ゴミ箱を空にするまで元に戻せます。元のカテゴリが削除されていれば、未分類に戻します。
      </p>
      <div className="detail__actions">
        <button type="button" className="button" disabled={!selected} onClick={onRestore}>
          <Icon d={ICONS.undo} />
          元に戻す
        </button>
        <button type="button" className="button" disabled={!selected} onClick={onPurge}>
          <Icon d={ICONS.x} />
          完全に削除
        </button>
        <button type="button" className="button" disabled={!count} onClick={onEmpty}>
          <Icon d={ICONS.trash} />
          ゴミ箱を空にする
        </button>
      </div>
    </aside>
  )
}
