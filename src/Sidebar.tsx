import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import Status from './Status'
import type { Category, Gallery } from './galleryTypes'

type Props = {
  gallery: Gallery
  // 失敗したら理由の文字列で reject する
  onRename: (id: number, name: string) => Promise<void>
  onMove: (id: number, parent: number | null) => void
}

// ドロップ先の目印。ROOT は見出しに落としたとき（ルート直下へ移す）
const ROOT = 'root'

// shortcut: 表示だけで、選んで絞り込む操作と、カテゴリ・タグの件数は持たない。絞り込み（FR-504、タスク#14）で足す
export default function Sidebar({ gallery, onRename, onMove }: Props) {
  const children = new Map<number | null, Category[]>()
  for (const c of gallery.categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const parentOf = new Map(gallery.categories.map((c) => [c.id, c.parent_id]))
  const uncategorized = gallery.images.filter((i) => i.category_id === null).length

  const [editing, setEditing] = useState<{ id: number; name: string; error?: string } | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | typeof ROOT | null>(null)

  // 自分自身と子孫の下へは移せない（FR-412）。祖先をたどって dragged に当たるかを見る
  const accepts = (target: number | null) => {
    for (let id: number | null = target; id !== null; id = parentOf.get(id) ?? null) if (id === dragged) return false
    return dragged !== null
  }
  const dropProps = (target: number | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts(target)) return
      e.preventDefault()
      setOver(target ?? ROOT)
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setOver(null)
      if (dragged !== null && parentOf.get(dragged) !== target) onMove(dragged, target)
    },
  })

  async function commit() {
    if (!editing) return
    try {
      await onRename(editing.id, editing.name)
      setEditing(null)
    } catch (e) {
      setEditing({ ...editing, error: String(e) })
    }
  }

  const tree = (parent: number | null, depth: number): ReactNode =>
    children.get(parent)?.map((c) => (
      <li key={c.id}>
        {editing?.id === c.id ? (
          <div className="sidebar__edit" style={{ '--depth': depth } as CSSProperties}>
            <input
              className={editing.error ? 'sidebar__input sidebar__input--error' : 'sidebar__input'}
              aria-label="カテゴリ名"
              aria-invalid={!!editing.error}
              aria-describedby={editing.error ? 'sidebar-rename-error' : undefined}
              value={editing.name}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
              onKeyDown={(e) => {
                // かな漢字変換を確定する Enter では変えない
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
                if (e.key === 'Escape') setEditing(null)
              }}
              onBlur={() => setEditing(null)}
            />
            {editing.error && (
              <span id="sidebar-rename-error">
                <Status kind="error">{editing.error}</Status>
              </span>
            )}
          </div>
        ) : (
          <span
            className={`sidebar__item sidebar__item--category${over === c.id ? ' sidebar__item--drop' : ''}`}
            style={{ '--depth': depth } as CSSProperties}
            draggable
            title="ダブルクリックで名前を変える。ドラッグで移す"
            onDoubleClick={() => setEditing({ id: c.id, name: c.name })}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', c.name)
              setDragged(c.id)
            }}
            onDragEnd={() => {
              setDragged(null)
              setOver(null)
            }}
            {...dropProps(c.id)}
          >
            {c.name}
          </span>
        )}
        {children.has(c.id) && <ul className="sidebar__list">{tree(c.id, depth + 1)}</ul>}
      </li>
    ))

  return (
    <nav className="gallery__sidebar" aria-label="サイドバー">
      <ul className="sidebar__list">
        <li className="sidebar__item sidebar__item--selected" aria-current="true">
          すべての画像<span className="sidebar__count">{gallery.images.length}</span>
        </li>
        <li className="sidebar__item">
          未分類<span className="sidebar__count">{uncategorized}</span>
        </li>
      </ul>
      <h2
        className={`sidebar__heading${over === ROOT ? ' sidebar__heading--drop' : ''}`}
        id="sidebar-categories"
        {...dropProps(null)}
      >
        カテゴリ
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-categories">
        {tree(null, 0)}
      </ul>
      <h2 className="sidebar__heading" id="sidebar-tags">
        タグ
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-tags">
        {gallery.tags.map((t) => (
          <li key={t.id} className="sidebar__item">
            {t.name}
          </li>
        ))}
      </ul>
    </nav>
  )
}
