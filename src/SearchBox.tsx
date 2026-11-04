import { useId, useState, type KeyboardEvent } from 'react'
import { filterCandidates, type FilterCandidate } from './choices'
import type { Filter } from './filter'
import type { Category, Tag } from './galleryTypes'

const KIND = { category: 'カテゴリ', tag: 'タグ' }

// 検索バー（FR-504）。入力した文字でファイル名とメモを絞り込み、名前の合うカテゴリとタグを候補に出す。
// 候補を選ぶとそのカテゴリかタグで絞り込み、入力した文字は消す（文字での絞り込みと重ねないため）
export default function SearchBox({
  filter,
  categories,
  tags,
  onFilter,
}: {
  filter: Filter
  categories: Category[]
  tags: Tag[]
  onFilter: (filter: Filter) => void
}) {
  const [focused, setFocused] = useState(false)
  // 候補のうちキーボードで選んでいるもの。-1 は入力した文字そのもの
  const [active, setActive] = useState(-1)
  const listId = useId()
  const shown = focused ? filterCandidates(categories, tags, filter.text, filter) : []

  const pick = (c: FilterCandidate) => {
    setActive(-1)
    onFilter(
      c.kind === 'category'
        ? { ...filter, category: c.id, text: '' }
        : { ...filter, tags: [...filter.tags, c.id], text: '' },
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // かな漢字変換を確定する Enter では選ばない（Safari は確定の keydown の keyCode が 229 になる）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const by = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (by && shown.length) {
      e.preventDefault()
      setActive((a) => ((a + 1 + by + shown.length + 1) % (shown.length + 1)) - 1)
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      pick(shown[active])
    } else if (e.key === 'Escape') {
      setActive(-1)
      onFilter({ ...filter, text: '' })
    }
  }

  return (
    <div className="search">
      <input
        className="gallery__search"
        type="search"
        placeholder="ファイル名とメモを検索。カテゴリとタグは候補から選ぶ"
        aria-label="検索"
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        value={filter.text}
        onChange={(e) => {
          setActive(-1)
          onFilter({ ...filter, text: e.target.value })
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {shown.length > 0 && (
        <ul id={listId} className="tag-input__list" role="listbox" aria-label="絞り込みの候補">
          {shown.map((c, i) => (
            <li
              key={`${c.kind}${c.id}`}
              id={`${listId}-${i}`}
              className="tag-input__option search__option"
              role="option"
              aria-selected={i === active}
              // 押しても入力欄からフォーカスを外さない（外れると候補が消えてクリックが届かない）
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
            >
              <span className="search__kind">{KIND[c.kind]}</span>
              {c.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
