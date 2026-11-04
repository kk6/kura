import type { CSSProperties, ReactNode } from 'react'
import type { Category, Gallery } from './galleryTypes'

// shortcut: 表示だけで、選んで絞り込む操作と、カテゴリ・タグの件数は持たない。絞り込み（FR-504、タスク#14）で足す
export default function Sidebar({ gallery }: { gallery: Gallery }) {
  const children = new Map<number | null, Category[]>()
  for (const c of gallery.categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const uncategorized = gallery.images.filter((i) => i.category_id === null).length

  const tree = (parent: number | null, depth: number): ReactNode =>
    children.get(parent)?.map((c) => (
      <li key={c.id}>
        <span className="sidebar__item sidebar__item--category" style={{ '--depth': depth } as CSSProperties}>
          {c.name}
        </span>
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
      <h2 className="sidebar__heading" id="sidebar-categories">
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
