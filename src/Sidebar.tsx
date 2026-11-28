import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { subtree } from './categoryTree'
import { tagsByName } from './choices'
import ConfirmDialog from './ConfirmDialog'
import { useContextMenu } from './contextMenu'
import MergeCategoryDialog from './MergeCategoryDialog'
import MoveCategoryDialog from './MoveCategoryDialog'
import Status from './Status'
import { type countImages, type Filter, selectCategory, selectTags, toggleExclude } from './filter'
import type { Category, Gallery } from './galleryTypes'
import { Icon, ICONS } from './icons'
import { select } from './selection'
import './Sidebar.css'

type Props = {
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
  // カテゴリの統合（FR-417）。id を into に統合する
  onMerge: (id: number, into: number) => void
  // カテゴリを閉じる・開く。閉じた状態はライブラリの DB に残る
  onCollapse: (ids: number[], collapsed: boolean) => void
  // カテゴリを移すときに確認する（アプリの設定）。確認で「今後は確認しない」を選ぶと onSkipConfirm を呼ぶ
  confirmMove: boolean
  onSkipConfirm: () => void
  // ゴミ箱（FR-511）と見つからない画像（FR-104）。開いている間は、カテゴリの選択を目立たせない
  trashCount: number
  missingCount: number
  aside: 'trash' | 'missing' | null
  onAside: (aside: 'trash' | 'missing') => void
  // 差分検出（FR-104）。scanning の間はボタンを押せない
  scanning: boolean
  onScan: () => void
  // ライブラリの場所。押すと Finder で開く
  root: string
  onReveal: () => void
  // タグ一覧を閉じているか（アプリ全体の設定）。閉じていても、選んでいるタグは出す
  tagsCollapsed: boolean
  // カテゴリで絞り込むときとカテゴリの件数に、子カテゴリの画像を含めるか（FR-516）
  categoryChildren: boolean
  onCategoryChildren: (children: boolean) => void
  onTagsCollapse: (collapsed: boolean) => void
}

// 長いパスは途中を … で省き、先頭のフォルダと最後の2つを残す（全体は title で出す）
const shortPath = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 3 ? path : `/${parts[0]}/…/${parts.slice(-2).join('/')}`
}

// ドロップ先の目印。ROOT は見出しに落としたとき（ルート直下へ移す）
const ROOT = 'root'
// ドラッグとみなす動きの距離（px）
const DRAG_START = 4

// ドラッグ中のポインターの下。none は落とせる先の外、self は自分か子孫、same は今の親、target は移せる先
type Hit = 'none' | 'self' | 'same' | { target: number | null }

export default function Sidebar(props: Props) {
  const { gallery, filter, counts, onFilter, onManageTags, onRename, onCreate, onMove, onDelete, onCollapse } = props
  const current = props.aside ? null : filter.category
  const children = new Map<number | null, Category[]>()
  for (const c of gallery.categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const parentOf = new Map(gallery.categories.map((c) => [c.id, c.parent_id]))
  const scope = (category: Filter['category']) => onFilter(selectCategory(filter, category))
  // ⌥ を押しながら押すと除く・戻す（FR-517）
  const exclude = (kind: 'tag' | 'category', id: number) => onFilter(toggleExclude(filter, kind, id))
  const excludedTags = new Set(filter.excludeTags)
  const excludedCategories = new Set(filter.excludeCategories)
  // タグ一覧を名前で絞り込む文字（FR-518）。画像の絞り込みには使わず、保存もしない
  const [tagQuery, setTagQuery] = useState('')

  // タグは押すたびに選ぶ・外すが切り替わる（FR-504、pickTag）。Shift の範囲は一覧の画像と同じで、選んだタグを先頭へ寄せる前の並び順で決める。
  // 寄せた後の並びで決めると、押すたびに並びが変わり、範囲が予想できなくなるため
  const tagOrder = gallery.tags.map((t) => t.id)
  const [tagAnchor, setTagAnchor] = useState<number | null>(null)
  const setTags = (tags: number[], anchor: number | null) => {
    setTagAnchor(anchor)
    onFilter(selectTags(filter, tags))
  }
  // タグの選択を外す。除くタグも外す。どちらもタグの条件なので、まとめて元に戻せるようにする
  const clearTags = () => {
    setTagAnchor(null)
    onFilter({ ...filter, tags: [], excludeTags: [] })
  }
  const pickTag = (e: MouseEvent<HTMLButtonElement>, id: number) => {
    // macOS の WebKit はクリックでボタンにフォーカスを移さない。続く Escape と ⌘A をタグに効かせるため移す
    e.currentTarget.focus()
    if (e.altKey) return exclude('tag', id)
    // 修飾キーなしでも ⌘ と同じく、押したタグだけを選ぶ・外す。一覧の画像と違い、タグは押して入れたり切ったりする
    // 部品に見え、マウスだけで複数を選べるようにするため。別のタグ1つへ移るときは Escape か余白で外してから押す
    const s = select({ ids: new Set(filter.tags), anchor: tagAnchor }, tagOrder, id, {
      shift: e.shiftKey,
      meta: !e.shiftKey,
    })
    setTags([...s.ids], s.anchor)
  }
  const onTagKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') clearTags()
    else if (e.metaKey && e.key.toLowerCase() === 'a') setTags(tagOrder, tagOrder[0] ?? null)
    else return
    // 一覧の画像の Escape と ⌘A（Gallery が window で受ける）に渡さない
    e.preventDefault()
    e.stopPropagation()
  }

  const collapsed = new Set(gallery.categories.filter((c) => c.collapsed).map((c) => c.id))
  const toggle = (id: number) => onCollapse([id], !collapsed.has(id))

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
  // 統合先を選んでいるカテゴリ（FR-417）
  const [merging, setMerging] = useState<number | null>(null)
  // 右クリックしたカテゴリと、そのメニューの位置
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const { at: menuAt, setAt: setMenuAt, ref: menuRef } = useContextMenu()
  const menuItems: [string, (id: number) => void][] = [
    // 読み仮名の欄は FR-418 で足す。今は名前だけをダブルクリックと同じ欄で変える
    ['名前と読み仮名を変更…', (id) => setEditing({ kind: 'rename', id, name: nameOf(id) ?? '' })],
    ['統合…', setMerging],
    ['削除…', setDeleting],
  ]

  // HTML5 のドラッグ＆ドロップは使わない。Tauri がファイルのドロップ（取り込み）を受けるために
  // ウェブビューのドラッグを横取りし、drop がページに届かないため。ポインターの動きで自前に行う
  useEffect(() => {
    if (!press) return
    const hitAt = (e: PointerEvent): Hit => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop]')
      if (!el) return 'none'
      const target = el.dataset.drop === ROOT ? null : Number(el.dataset.drop)
      // 自分自身と子孫の下へは移せない（FR-412）。祖先をたどって押したカテゴリに当たるかを見る
      for (let id: number | null = target; id !== null; id = parentOf.get(id) ?? null)
        if (id === press.id) return 'self'
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
        if (!props.confirmMove) onMove(press.id, hit.target)
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

  // カテゴリと子孫のカテゴリにある画像の枚数。削除と統合の確認に出す
  const imagesIn = (id: number) => {
    const ids = subtree(gallery.categories, id)
    return gallery.images.filter((i) => i.category_id !== null && ids.has(i.category_id)).length
  }
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
              className={`sidebar__item sidebar__item--category${current === c.id ? ' sidebar__item--selected' : ''}${over === c.id ? ' sidebar__item--drop' : ''}${drag && press?.id === c.id ? ' sidebar__item--dragging' : ''}`}
              style={{ '--depth': depth } as CSSProperties}
              data-drop={c.id}
              title="押すと絞り込む。ダブルクリックで名前を変える。ドラッグで移す"
              onDoubleClick={() => setEditing({ kind: 'rename', id: c.id, name: c.name })}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuFor(c.id)
                setMenuAt({ x: e.clientX, y: e.clientY })
              }}
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
              <span className="sidebar__folder">
                <Icon d={ICONS.folder} />
              </span>
              <button
                type="button"
                className={`sidebar__name${excludedCategories.has(c.id) ? ' sidebar__name--excluded' : ''}`}
                aria-current={current === c.id}
                aria-label={excludedCategories.has(c.id) ? `${c.name}（除く）` : undefined}
                onClick={(e) => (e.altKey ? exclude('category', c.id) : scope(c.id))}
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
    <nav
      className="gallery__sidebar"
      aria-label="サイドバー"
      // 余白（項目のない所）を押すとタグの選択を外す。click だと、カテゴリのドラッグを余白で離したときにも届くので押した時点で見る
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && e.button === 0 && (filter.tags.length || filter.excludeTags.length))
          clearTags()
      }}
    >
      <h2 className="sidebar__heading" id="sidebar-library">
        ライブラリ
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-library">
        <li>
          <button
            type="button"
            className={`sidebar__item sidebar__button${current === 'all' ? ' sidebar__item--selected' : ''}`}
            aria-current={current === 'all'}
            onClick={() => scope('all')}
          >
            <Icon d={ICONS.images} />
            <span className="sidebar__name">すべての画像</span>
            <span className="sidebar__count">{gallery.images.length}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`sidebar__item sidebar__button${current === 'uncategorized' ? ' sidebar__item--selected' : ''}`}
            aria-current={current === 'uncategorized'}
            onClick={() => scope('uncategorized')}
          >
            <Icon d={ICONS.inbox} />
            <span className="sidebar__name">未分類</span>
            <span className="sidebar__count">{counts.uncategorized}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`sidebar__item sidebar__button${props.aside === 'trash' ? ' sidebar__item--selected' : ''}`}
            aria-current={props.aside === 'trash'}
            onClick={() => props.onAside('trash')}
          >
            <Icon d={ICONS.trash} />
            <span className="sidebar__name">ゴミ箱</span>
            <span className="sidebar__count">{props.trashCount}</span>
          </button>
        </li>
        {/* 見つからない画像があるときだけ出す。開いている間は0枚になっても残す */}
        {(props.missingCount > 0 || props.aside === 'missing') && (
          <li>
            <button
              type="button"
              className={`sidebar__item sidebar__button${props.aside === 'missing' ? ' sidebar__item--selected' : ''}`}
              aria-current={props.aside === 'missing'}
              onClick={() => props.onAside('missing')}
            >
              <Icon d={ICONS.imageOff} />
              <span className="sidebar__name">見つからない</span>
              <span className="sidebar__count">{props.missingCount}</span>
            </button>
          </li>
        )}
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
            onClick={() =>
              onCollapse([...children.keys()].filter((id) => id !== null && !collapsed.has(id)) as number[], true)
            }
          >
            <Icon d="M7 11l5-5 5 5M7 18l5-5 5 5" />
          </button>
          <button
            type="button"
            role="switch"
            className="sidebar__add"
            aria-label="子カテゴリの画像を含める"
            aria-checked={props.categoryChildren}
            title={
              props.categoryChildren
                ? '子カテゴリの画像を含めています。押すと、選んだカテゴリの直下の画像だけを出します'
                : '選んだカテゴリの直下の画像だけを出しています。押すと、子カテゴリの画像も含めます'
            }
            onClick={() => props.onCategoryChildren(!props.categoryChildren)}
          >
            <Icon d={props.categoryChildren ? ICONS.listTree : ICONS.listFlat} />
          </button>
          <button
            type="button"
            className="sidebar__add"
            aria-label="差分を確認"
            title="Finder で足した・移した・消した画像とフォルダを反映する"
            disabled={props.scanning}
            onClick={props.onScan}
          >
            <Icon d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </button>
        </span>
      </h2>
      <ul className="sidebar__list" aria-labelledby="sidebar-categories">
        {tree(null, 0)}
      </ul>
      <h2 className="sidebar__heading" id="sidebar-tags">
        <button
          type="button"
          className="sidebar__section"
          aria-expanded={!props.tagsCollapsed}
          onClick={() => props.onTagsCollapse(!props.tagsCollapsed)}
        >
          タグ
          <span className="sidebar__toggle">
            <Icon d={props.tagsCollapsed ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} />
          </span>
        </button>
        <span className="sidebar__actions">
          {/* 選んだタグをすべて含む（AND）か、どれかを含む（OR）か。つまみ（::before）が選んだ側へ滑る */}
          <span
            className={`switch${filter.mode === 'or' ? ' switch--right' : ''}`}
            role="group"
            aria-label="タグの組み合わせ"
          >
            {(['and', 'or'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`switch__option${filter.mode === mode ? ' switch__option--on' : ''}`}
                aria-pressed={filter.mode === mode}
                title={mode === 'and' ? '選んだタグをすべて含む画像' : '選んだタグのどれかを含む画像'}
                onClick={() => onFilter({ ...filter, mode })}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </span>
          <button type="button" className="sidebar__add" aria-label="タグを管理する" onClick={onManageTags}>
            <Icon d="M4 6h16M4 12h16M4 18h10" />
          </button>
        </span>
      </h2>
      {/* 閉じている間は一覧がないので出さない。入力した文字は閉じても残す */}
      {!props.tagsCollapsed && (
        <div className="sidebar__tag-search">
          <input
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="sidebar__input sidebar__search"
            type="search"
            placeholder="タグを探す"
            aria-label="タグを名前で絞り込む"
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            onKeyDown={(e) => {
              // かな漢字変換を取り消す Escape では消さない
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) setTagQuery('')
            }}
          />
        </div>
      )}
      <ul className="sidebar__tags" aria-labelledby="sidebar-tags" onKeyDown={onTagKey}>
        {/* 閉じていても選んでいるタグは出す。何で絞り込んでいるかが見えなくならないように */}
        {/* 選んでいるタグは先頭へ寄せる。スクロールの外で選ばれたままのタグに気づかず、絞り込みを誤解しないように */}
        {tagsByName(gallery.tags, props.tagsCollapsed ? '' : tagQuery, new Set([...filter.tags, ...excludedTags]))
          .filter((t) => !props.tagsCollapsed || filter.tags.includes(t.id) || excludedTags.has(t.id))
          // 除いているタグも、選んでいるタグと同じく先頭へ寄せる
          .sort(
            (a, b) =>
              Number(filter.tags.includes(b.id) || excludedTags.has(b.id)) -
              Number(filter.tags.includes(a.id) || excludedTags.has(a.id)),
          )
          .map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`sidebar__tag${filter.tags.includes(t.id) ? ' sidebar__tag--selected' : ''}${excludedTags.has(t.id) ? ' sidebar__tag--excluded' : ''}`}
                aria-pressed={filter.tags.includes(t.id)}
                aria-label={excludedTags.has(t.id) ? `${t.name} ${counts.tags.get(t.id) ?? 0}（除く）` : undefined}
                title={excludedTags.has(t.id) ? '除いています。⌥ を押しながら押すと戻します' : undefined}
                onClick={(e) => pickTag(e, t.id)}
              >
                <span className="sidebar__name">{t.name}</span>
                <span className="sidebar__count">{counts.tags.get(t.id) ?? 0}</span>
              </button>
            </li>
          ))}
      </ul>
      <button type="button" className="sidebar__location" title={props.root} onClick={props.onReveal}>
        <Icon d={ICONS.folder} />
        <span className="sidebar__location-text">
          <span className="sidebar__location-label">ライブラリの場所</span>
          <span className="sidebar__path">{shortPath(props.root)}</span>
        </span>
      </button>
      {drag && press && (
        <div className="sidebar__drag" style={{ left: drag.x, top: drag.y }} role="status">
          {dragLabel(drag.hit)}
        </div>
      )}
      {menuAt && menuFor !== null && (
        <div ref={menuRef} className="menu" role="menu" popover="manual" style={{ top: menuAt.y, left: menuAt.x }}>
          {menuItems.map(([label, run]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                setMenuAt(null)
                run(menuFor)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {merging !== null && (
        <MergeCategoryDialog
          id={merging}
          categories={gallery.categories}
          images={imagesIn(merging)}
          onConfirm={(into) => {
            props.onMerge(merging, into)
            setMerging(null)
          }}
          onClose={() => setMerging(null)}
        />
      )}
      {deleting !== null &&
        (() => {
          const ids = subtree(gallery.categories, deleting)
          const images = imagesIn(deleting)
          return (
            <ConfirmDialog
              title="カテゴリを削除する"
              confirm="削除する"
              onConfirm={() => {
                onDelete(deleting)
                setDeleting(null)
              }}
              onClose={() => setDeleting(null)}
            >
              「{nameOf(deleting)}」{ids.size > 1 && `と子カテゴリ ${ids.size - 1}個`}を削除します。中の画像 {images}
              枚は未分類へ移ります。画像は削除しません。
            </ConfirmDialog>
          )
        })()}
      {pending && (
        <MoveCategoryDialog
          name={nameOf(pending.id) ?? ''}
          to={place(pending.parent)}
          onConfirm={(skip) => {
            if (skip) props.onSkipConfirm()
            onMove(pending.id, pending.parent)
            setPending(null)
          }}
          onClose={() => setPending(null)}
        />
      )}
    </nav>
  )
}
