import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
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
// ドラッグとみなす動きの距離（px）
const DRAG_START = 4

// shortcut: 表示だけで、選んで絞り込む操作と、カテゴリ・タグの件数は持たない。絞り込み（FR-504、タスク#14）で足す
export default function Sidebar({ gallery, onRename, onMove }: Props) {
  const children = new Map<number | null, Category[]>()
  for (const c of gallery.categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const parentOf = new Map(gallery.categories.map((c) => [c.id, c.parent_id]))
  const uncategorized = gallery.images.filter((i) => i.category_id === null).length

  const [editing, setEditing] = useState<{ id: number; name: string; error?: string } | null>(null)
  // 押した位置。少し動かしたらドラッグとみなす（ダブルクリックと区別するため）
  const [press, setPress] = useState<{ id: number; x: number; y: number } | null>(null)
  const [over, setOver] = useState<number | typeof ROOT | null>(null)

  // 自分自身と子孫の下へは移せない（FR-412）。祖先をたどって押したカテゴリに当たるかを見る
  const accepts = (target: number | null) => {
    if (!press) return false
    for (let id: number | null = target; id !== null; id = parentOf.get(id) ?? null) if (id === press.id) return false
    return true
  }

  // HTML5 のドラッグ＆ドロップは使わない。Tauri がファイルのドロップ（取り込み）を受けるために
  // ウェブビューのドラッグを横取りし、drop がページに届かないため。ポインターの動きで自前に行う
  useEffect(() => {
    if (!press) return
    const targetAt = (e: PointerEvent): number | null | undefined => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop]')
      if (!el) return undefined
      const target = el.dataset.drop === ROOT ? null : Number(el.dataset.drop)
      return accepts(target) ? target : undefined
    }
    // state の更新を待たずに判定できるよう、押した位置からの距離で決める
    const moved = (e: PointerEvent) => Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_START
    const onMoveEvent = (e: PointerEvent) => {
      if (!moved(e)) return
      const target = targetAt(e)
      setOver(target === undefined ? null : (target ?? ROOT))
    }
    const onUp = (e: PointerEvent) => {
      const target = moved(e) ? targetAt(e) : undefined
      if (target !== undefined && parentOf.get(press.id) !== target) onMove(press.id, target)
      setPress(null)
      setOver(null)
    }
    window.addEventListener('pointermove', onMoveEvent)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMoveEvent)
      window.removeEventListener('pointerup', onUp)
    }
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
            data-drop={c.id}
            title="ダブルクリックで名前を変える。ドラッグで移す"
            onDoubleClick={() => setEditing({ id: c.id, name: c.name })}
            onPointerDown={(e) => e.button === 0 && setPress({ id: c.id, x: e.clientX, y: e.clientY })}
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
        data-drop={ROOT}
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
