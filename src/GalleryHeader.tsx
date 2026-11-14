import type { Filter } from './filter'
import type { Category, Tag } from './galleryTypes'
import { Icon, ICONS } from './icons'
import SearchBox from './SearchBox'
import './GalleryHeader.css'

type Props = {
  root: string
  // 最近使ったライブラリ。ライブラリのメニューに出す（FR-105）
  recent: string[]
  filter: Filter
  categories: Category[]
  tags: Tag[]
  onFilter: (filter: Filter) => void
  // 取り込みか差分検出の途中なら、その種類
  busy: 'scan' | 'import' | null
  // 取り込む画像（directory が true ならフォルダ）を選ぶ
  onPick: (directory: boolean) => void
  // アイデアボードを開く。ボードを使わない設定では渡さず、ボタンを出さない
  onOpenBoard?: () => void
  onSettings: () => void
  // path のライブラリへ切り替える。path がなければライブラリ選択画面へ戻る
  onLeave: (path?: string) => void
}

export default function GalleryHeader(props: Props) {
  const { root, recent, busy } = props
  return (
    <header className="gallery__header">
      <span className="gallery__brand">
        <span className="gallery__mark">
          <Icon d={ICONS.kura} size={28} />
        </span>
        <span className="gallery__brand-text">
          <span className="gallery__logo">Kura</span>
          {/* ネイティブのメニューにすると、今のライブラリに macOS のチェックが付く */}
          <select
            className="gallery__library"
            aria-label="ライブラリ"
            title={root}
            value={root}
            onChange={(e) => props.onLeave(e.target.value || undefined)}
          >
            <optgroup label="最近使ったライブラリ">
              {(recent.includes(root) ? recent : [root, ...recent]).map((path) => (
                <option key={path} value={path}>
                  {baseName(path)}
                </option>
              ))}
            </optgroup>
            <option value="">ほかのライブラリを開く…</option>
          </select>
        </span>
      </span>
      <SearchBox filter={props.filter} categories={props.categories} tags={props.tags} onFilter={props.onFilter} />
      {/* 取り込みと差分検出の間は、押せないボタンを残さず処理中であることを出す。押せない理由がわからないと壊れたと思われるため。
          ボタンは見えないまま場所を取り、ヘッダーの幅が変わらないようにする */}
      <span className="gallery__import">
        <span className="gallery__import-buttons" hidden={busy !== null}>
          <button type="button" className="button" onClick={() => props.onPick(false)}>
            <Icon d={ICONS.imagePlus} />
            画像を取り込む
          </button>
          <button type="button" className="button" onClick={() => props.onPick(true)}>
            <Icon d={ICONS.folderPlus} />
            フォルダを取り込む
          </button>
        </span>
        {busy && (
          <span className="gallery__busy" role="status">
            <Spinner />
            {busy === 'scan' ? 'Finder での変更を反映中…' : '取り込み中…'}
          </span>
        )}
      </span>
      {props.onOpenBoard && (
        <button
          type="button"
          className="button button--primary"
          title="アイデアボード（⌘B）"
          onClick={props.onOpenBoard}
        >
          <Icon d={ICONS.board} />
          アイデアボード
        </button>
      )}
      <button
        type="button"
        className="button button--icon"
        aria-label="設定"
        title="設定（⌘,）"
        onClick={props.onSettings}
      >
        <Icon d={ICONS.settings} />
      </button>
    </header>
  )
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// 処理中を示す、回る円弧のアイコン
const Spinner = () => (
  <svg
    className="spinner"
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 3a9 9 0 1 1-9 9" />
  </svg>
)
