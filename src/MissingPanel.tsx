import { Icon, ICONS } from './icons'
import './Detail.css'

// 見つからない画像（FR-104）を開いている間に、詳細パネルの場所に出す
export default function MissingPanel({
  selected,
  name,
  onForget,
}: {
  selected: number
  // 1枚だけ選んでいるときのファイル名
  name?: string
  // 一覧から外す確認を出す。確認は右クリックからも出すので、Gallery が持つ
  onForget: () => void
}) {
  return (
    <aside className="gallery__detail" aria-label="見つからない画像">
      <h2 className="detail__name">{name ?? (selected ? `${selected}枚を選んでいます` : '見つからない画像')}</h2>
      <p className="detail__note">
        Finder
        で消したか、ライブラリの外へ移した画像です。ファイルを元の場所に戻すか、ライブラリの中に置いて、サイドバーの「カテゴリ」の見出しにある
        ↻（差分を確認）を押すと、タグとメモを残したまま一覧に戻ります。
      </p>
      <div className="detail__actions">
        <button type="button" className="button" disabled={!selected} onClick={onForget}>
          <Icon d={ICONS.listX} />
          一覧から外す
        </button>
      </div>
    </aside>
  )
}
