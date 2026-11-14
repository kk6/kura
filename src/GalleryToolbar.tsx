import type { ReactNode } from 'react'
import { Icon, ICONS } from './icons'
import { SORTS, type SortKey } from './sort'
import './GalleryToolbar.css'

// サムネイルの列の幅の目安。上限はサムネイルの幅（320）
export const THUMB_MIN = 100
export const THUMB_MAX = 320
const THUMB_STEP = 10

type Props = {
  title: string
  count: number
  // 並べ替え。ゴミ箱と見つからない画像では渡さず、メニューを出さない
  sort?: SortKey
  onSort: (sort: SortKey) => void
  detailShown: boolean
  onToggleDetail: () => void
  // 大きさを変える操作（ThumbSlider か、拡大表示の間は ZoomSlider）
  children: ReactNode
}

// 一覧の上の帯
export default function GalleryToolbar({ title, count, sort, onSort, detailShown, onToggleDetail, children }: Props) {
  return (
    <div className="gallery__toolbar">
      <h1 className="toolbar__title">{title}</h1>
      <span className="toolbar__count">{count}枚</span>
      <span className="toolbar__spacer" />
      {sort && (
        <select
          className="gallery__sort"
          aria-label="並べ替え"
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
        >
          {Object.entries(SORTS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      )}
      {children}
      <button
        type="button"
        className="button button--icon"
        aria-label={detailShown ? '詳細パネルを閉じる' : '詳細パネルを開く'}
        aria-pressed={detailShown}
        title={`詳細パネルを${detailShown ? '閉じる' : '開く'}（⌘I）`}
        onClick={onToggleDetail}
      >
        <Icon d={ICONS.panelRight} />
      </button>
    </div>
  )
}

// サムネイルの大きさのスライダーと、左右の1段ずつ変えるアイコン
export function ThumbSlider({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  return (
    <span className="toolbar__size">
      <button
        type="button"
        className="toolbar__step"
        aria-label="サムネイルを小さくする"
        disabled={width <= THUMB_MIN}
        onClick={() => onChange(Math.max(THUMB_MIN, width - THUMB_STEP))}
      >
        <Icon d={ICONS.masonryMany} />
      </button>
      <input
        className="slider"
        type="range"
        aria-label="サムネイルの大きさ"
        min={THUMB_MIN}
        max={THUMB_MAX}
        step={THUMB_STEP}
        value={width}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <button
        type="button"
        className="toolbar__step"
        aria-label="サムネイルを大きくする"
        disabled={width >= THUMB_MAX}
        onClick={() => onChange(Math.min(THUMB_MAX, width + THUMB_STEP))}
      >
        <Icon d={ICONS.masonryFew} />
      </button>
    </span>
  )
}
