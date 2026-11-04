import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { subtree } from './categoryTree'
import DeleteCategoryDialog from './DeleteCategoryDialog'
import MoveCategoryDialog from './MoveCategoryDialog'
import Status from './Status'
import type { countImages, Filter } from './filter'
import type { Category, Gallery } from './galleryTypes'

type Props = {
  // 開いているライブラリ。カテゴリの開閉の状態をライブラリごとに覚えるのに使う
  root: string
  gallery: Gallery
  // 絞り込み（FR-504）。カテゴリとタグを押すと変える
  filter: Filter
  counts: ReturnType<typeof countImages>
  onFilter: (filter: Filter) => void
  onManageTags: () => void
  // 失敗したら理由の文字列で reject する
  onRename: (id: number, name: string) => Promise<void>
  onCreate: (parent: number | null, name: string) => Promise<void>
  onMove: (id: number, parent: number | null) => void
  onDelete: (id: number) => void
}

// ドロップ先の目印。ROOT は見出しに落としたとき（ルート直下へ移す）
const ROOT = 'root'
// ドラッグとみなす動きの距離（px）
const DRAG_START = 4
// 移動の確認ダイアログで「今後は確認しない」を選んだ印。
// shortcut: このウェブビューに保存するだけで、戻す画面がない。設定ダイアログ（タスク#18）でアプリの設定に移し、戻せるようにする
export const SKIP_CONFIRM = 'kura.skipCategoryMoveConfirm'

// ドラッグ中のポインターの下。none は落とせる先の外、self は自分か子孫、same は今の親、target は移せる先
type Hit = 'none' | 'self' | 'same' | { target: number | null }

export default function Sidebar({ root, gallery, filter, counts, onFilter, onManageTags, onRename, onCreate, onMove, onDelete }: Props) {
  const children = new Map<number | null, Category[]>()
  for (const c of gallery.categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const parentOf = new Map(gallery.categories.map((c) => [c.id, c.parent_id]))
  const scope = (category: Filter['category']) => onFilter({ ...filter, category })
  const toggleTag = (id: number) =>
    onFilter({ ...filter, tags: filter.tags.includes(id) ? filter.tags.filter((t) => t !== id) : [...filter.tags, id] })

  // 閉じているカテゴリ。shortcut: このウェブビューに保存する。設定ダイアログ（タスク#18）でアプリの設定にまとめるなら移す
  const collapsedKey = `kura.collapsedCategories:${root}`
  const [collapsed, setCollapsed] = useState(
    () => new Set<number>(JSON.parse(localStorage.getItem(collapsedKey) ?? '[]') as number[]),
  )
  const saveCollapsed = (next: Set<number>) => {
    setCollapsed(next)
    localStorage.setItem(collapsedKey, JSON.stringify([...next]))
  }
  const toggle = (id: number) => {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    saveCollapsed(next)
  }

  // 名前を入力中のカテゴリ。rename は既存の名前の変更、create は parent の下（null はルート直下）への作成
  const [editing, setEditing] = useState<
    ({ kind: 'rename'; id: number } | { kind: 'create'; parent: number | null }) & { name: string; error?: string }
  >()
  // 押した位置。少し動かしたらドラッグとみなす（ダブルクリックと区別するため）
  const [press, setPress] = useState<{ id: number; x: number; y: number } | null>(null)
  // ドラッグ中のポインターの位置と、その下にあるもの
  const [drag, setDrag] = useState<{ x: number; y: number; hit: Hit } | null>(null)
  // 落とした後、確認ダイアログで答えを待っている移動
  const [pending, setPending] = useState<{ id: number; parent: number | null } | null>(null)
  const over = drag && typeof drag.hit === 'object' ? (drag.hit.target ?? ROOT) : null
  // 確認ダイアログで答えを待っている削除
  const [deleting, setDeleting] = useState<number | null>(null)

  // HTML5 のドラッグ＆ドロップは使わない。Tauri がファイルのドロップ（取り込み）を受けるために
  // ウェブビューのドラッグを横取りし、drop がページに届かないため。ポインターの動きで自前に行う
  useEffect(() => {
    if (!press) return
    const hitAt = (e: PointerEvent): Hit => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop]')
      if (!el) return 'none'
      const target = el.dataset.drop === ROOT ? null : Number(el.dataset.drop)
      // 自分自身と子孫の下へは移せない（FR-412）。祖先をたどって押したカテゴリに当たるかを見る
      for (let id: number | null = target; id !== null; id = parentOf.get(id) ?? null) if (id === press.id) return 'self'
      return target === parentOf.get(press.id) ? 'same' : { target }
    }
    // state の更新を待たずに判定できるよう、押した位置からの距離で決める
    const moved = (e: PointerEvent) => Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_START
    const end = () => {
      setPress(null)
      setDrag(null)
    }
    const onMoveEvent = (e: PointerEvent) => {
      if (moved(e)) setDrag({ x: e.clientX, y: e.clientY, hit: hitAt(e) })
    }
    const onUp = (e: PointerEvent) => {
      const hit = moved(e) ? hitAt(e) : 'none'
      if (typeof hit === 'object') {
        if (localStorage.getItem(SKIP_CONFIRM) === '1') onMove(press.id, hit.target)
        else setPending({ id: press.id, parent: hit.target })
      }
      end()
    }
    // Escape でドラッグをやめる。一覧の選択を外す Escape（Gallery）まで届かないよう、先に受けて止める
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      end()
    }
    window.addEventListener('pointermove', onMoveEvent)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMoveEvent)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  // ドラッグ中は、カーソルがサイドバーの外にあっても掴んでいる形にする
  const dragging = drag !== null
  useEffect(() => {
    document.body.classList.toggle('is-dragging', dragging)
  }, [dragging])

  const nameOf = (id: number | null) => gallery.categories.find((c) => c.id === id)?.name
  const place = (parent: number | null) => (parent === null ? '一番上の階層' : `「${nameOf(parent)}」の下`)
  const dragLabel = (hit: Hit) => {
    const name = `「${nameOf(press?.id ?? null)}」`
    if (hit === 'self') return `${name}を自分の中へは移せません`
    if (hit === 'same') return `${name}は今ここにあります`
    if (hit === 'none') return `${name}を移す（カテゴリか見出しの上で離す）`
    return `${name}を${place(hit.target)}へ移す`
  }

  async function commit() {
    if (!editing) return
    try {
      if (editing.kind === 'rename') await onRename(editing.id, editing.name)
      else await onCreate(editing.parent, editing.name)
      setEditing(undefined)
    } catch (e) {
      setEditing({ ...editing, error: String(e) })
    }
  }

  const field = (depth: number) =>
    editing && (
      <div className="sidebar__edit" style={{ '--depth': depth } as CSSProperties}>
        <input
          autoCorrect="off"
          autoCapitalize="off"
          className={editing.error ? 'sidebar__input sidebar__input--error' : 'sidebar__input'}
          aria-label={editing.kind === 'rename' ? 'カテゴリ名' : '新しいカテゴリ名'}
          aria-invalid={!!editing.error}
          aria-describedby={editing.error ? 'sidebar-name-error' : undefined}
          value={editing.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setEditing({ ...editing, name: e.target.value, error: undefined })}
          onKeyDown={(e) => {
            // かな漢字変換を確定する Enter では変えない
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
            if (e.key === 'Escape') setEditing(undefined)
          }}
          onBlur={() => setEditing(undefined)}
        />
        {editing.error && (
          <span id="sidebar-name-error">
            <Status kind="error">{editing.error}</Status>
          </span>
        )}
      </div>
    )

  const creatingIn = (parent: number | null) => editing?.kind === 'create' && editing.parent === parent

  const tree = (parent: number | null, depth: number): ReactNode => (
    <>
      {children.get(parent)?.map((c) => (
        <li key={c.id}>
          {editing?.kind === 'rename' && editing.id === c.id ? (
            field(depth)
          ) : (
          <span
            className={`sidebar__item sidebar__item--category${filter.category === c.id ? ' sidebar__item--selected' : ''}${over === c.id ? ' sidebar__item--drop' : ''}${drag && press?.id === c.id ? ' sidebar__item--dragging' : ''}`}
            style={{ '--depth': depth } as CSSProperties}
            data-drop={c.id}
            title="押すと絞り込む。ダブルクリックで名前を変える。ドラッグで移す"
            onDoubleClick={() => setEditing({ kind: 'rename', id: c.id, name: c.name })}
            onPointerDown={(e) => e.button === 0 && setPress({ id: c.id, x: e.clientX, y: e.clientY })}
            // ドラッグ中にカーソルの通った文字が選ばれないよう、押したときに文字の選択を始めない。
            // 既定の動きを止めるとフォーカスも移らず、入力中のカテゴリ名が blur で取り消されないので、自分で外す
            onMouseDown={(e) => {
              e.preventDefault()
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            }}
          >
            {children.has(c.id) ? (
              <button
                type="button"
                className="sidebar__toggle"
                aria-label={`${c.name} を${collapsed.has(c.id) ? '開く' : '閉じる'}`}
                aria-expanded={!collapsed.has(c.id)}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={() => toggle(c.id)}
              >
                <Icon d={collapsed.has(c.id) ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} />
              </button>
            ) : (
              <span className="sidebar__toggle" />
            )}
            <button
              type="button"
              className="sidebar__name"
              aria-current={filter.category === c.id}
              onClick={() => scope(c.id)}
            >
              {c.name}
            </button>
            <button
              type="button"
              className="sidebar__add sidebar__add--hover"
              aria-label={`${c.name} の下にカテゴリを作る`}
              // 押してもドラッグや名前の変更を始めない
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => {
                // 作る場所が見えるよう、閉じていれば開く
                if (collapsed.has(c.id)) toggle(c.id)
                setEditing({ kind: 'create', parent: c.id, name: '' })
              }}
            >
              <Icon d="M12 5v14M5 12h14" />
            </button>
            <button
              type="button"
              className="sidebar__add sidebar__add--hover"
              aria-label={`${c.name} を削除する`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => setDeleting(c.id)}
            >
              <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </button>
            {/* 件数は行の右端に置き、タグの件数と縦にそろえる */}
            <span className="sidebar__count">{counts.categories.get(c.id) ?? 0}</span>
          </span>
        )}
        {((children.has(c.id) && !collapsed.has(c.id)) || creatingIn(c.id)) && (
          // 子の並びの左に、親の開閉ボタンから下ろす線を引く（階層の深さを見分けるため）
          <ul className="sidebar__list sidebar__list--nested" style={{ '--depth': depth } as CSSProperties}>
            {tree(c.id, depth + 1)}
          </ul>
        )}
      </li>
      ))}
      {creatingIn(parent) && <li>{field(depth)}</li>}
    </>
  )

  return (
    <nav className="gallery__sidebar" aria-label="サイドバー">
      <ul className="sidebar__list">
        <li>
          <button
            type="button"
            className={`sidebar__item sidebar__button${filter.category === 'all' ? ' sidebar__item--selected' : ''}`}
            aria-current={filter.category === 'all'}
            onClick={() => scope('all')}
          >
            すべての画像<span className="sidebar__count">{gallery.images.length}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`sidebar__item sidebar__button${filter.category === 'uncategorized' ? ' sidebar__item--selected' : ''}`}
            aria-current={filter.category === 'uncategorized'}
            onClick={() => scope('uncategorized')}
          >
            未分類<span className="sidebar__count">{counts.uncategorized}</span>
          </button>
        </li>
      </ul>
      <h2
        className={`sidebar__heading${over === ROOT ? ' sidebar__heading--drop' : ''}`}
        id="sidebar-categories"
        data-drop={ROOT}
      >
        カテゴリ
        <span className="sidebar__actions">
          <button
            type="button"
            className="sidebar__add"
            aria-label="カテゴリを作る"
            onClick={() => setEditing({ kind: 'create', parent: null, name: '' })}
          >
            <Icon d="M12 5v14M5 12h14" />
          </button>
          <button
            type="button"
            className="sidebar__add"
            aria-label="すべて閉じる"
            onClick={() => saveCollapsed(new Set([...children.keys()].filter((id) => id !== null)))}
          >
            <Icon d="M7 11l5-5 5 5M7 18l5-5 5 5" />
          </button>
        </span>
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-categories">
        {tree(null, 0)}
      </ul>
      <h2 className="sidebar__heading" id="sidebar-tags">
        タグ
        {/* 選んだタグをすべて含む（AND）か、どれかを含む（OR）か */}
        <span className="sidebar__actions" role="group" aria-label="タグの組み合わせ">
          {(['and', 'or'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`sidebar__mode${filter.mode === mode ? ' sidebar__mode--on' : ''}`}
              aria-pressed={filter.mode === mode}
              title={mode === 'and' ? '選んだタグをすべて含む画像' : '選んだタグのどれかを含む画像'}
              onClick={() => onFilter({ ...filter, mode })}
            >
              {mode.toUpperCase()}
            </button>
          ))}
          <button type="button" className="sidebar__add" aria-label="タグを管理する" onClick={onManageTags}>
            <Icon d="M4 6h16M4 12h16M4 18h10" />
          </button>
        </span>
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-tags">
        {gallery.tags.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={`sidebar__item sidebar__button${filter.tags.includes(t.id) ? ' sidebar__item--selected' : ''}`}
              aria-pressed={filter.tags.includes(t.id)}
              onClick={() => toggleTag(t.id)}
            >
              <span className="sidebar__name">{t.name}</span>
              <span className="sidebar__count">{counts.tags.get(t.id) ?? 0}</span>
            </button>
          </li>
        ))}
      </ul>
      {drag && press && (
        <div className="sidebar__drag" style={{ left: drag.x, top: drag.y }} role="status">
          {dragLabel(drag.hit)}
        </div>
      )}
      {deleting !== null &&
        (() => {
          const ids = subtree(gallery.categories, deleting)
          return (
            <DeleteCategoryDialog
              name={nameOf(deleting) ?? ''}
              categories={ids.size}
              images={gallery.images.filter((i) => i.category_id !== null && ids.has(i.category_id)).length}
              onConfirm={() => {
                onDelete(deleting)
                setDeleting(null)
              }}
              onClose={() => setDeleting(null)}
            />
          )
        })()}
      {pending && (
        <MoveCategoryDialog
          name={nameOf(pending.id) ?? ''}
          to={place(pending.parent)}
          onConfirm={(skip) => {
            if (skip) localStorage.setItem(SKIP_CONFIRM, '1')
            onMove(pending.id, pending.parent)
            setPending(null)
          }}
          onClose={() => setPending(null)}
        />
      )}
    </nav>
  )
}

const Icon = ({ d }: { d: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
)
