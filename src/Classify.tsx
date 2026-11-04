import { invoke } from '@tauri-apps/api/core'
import { type KeyboardEvent, useCallback, useEffect, useId, useState } from 'react'
import Status from './Status'
import { candidates, categoryOptions } from './choices'
import type { Category, CountedTag, Image, Tag } from './galleryTypes'

// 選んだ画像（1枚でも複数でも）のカテゴリ（FR-402、FR-407）。選ぶとすぐに移す
export function CategorySelect({
  selected,
  categories,
  onAssign,
}: {
  selected: Image[]
  categories: Category[]
  // 移せなかった画像はステータスバーに出すので、reject するのはカテゴリがないときなど全体の失敗だけ
  onAssign: (ids: number[], category: number | null) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = selected[0].category_id
  const mixed = selected.some((i) => i.category_id !== first)

  const change = async (value: string) => {
    setBusy(true)
    try {
      await onAssign(
        selected.map((i) => i.id),
        value === '' ? null : Number(value),
      )
      setError(null)
    } catch (e) {
      setError(String(e))
    }
    setBusy(false)
  }

  return (
    <>
      <select
        id="detail-category"
        className={error ? 'detail__select detail__select--error' : 'detail__select'}
        value={mixed ? 'mixed' : String(first ?? '')}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        aria-invalid={!!error}
      >
        {mixed && (
          <option value="mixed" disabled>
            複数のカテゴリ
          </option>
        )}
        <option value="">未分類</option>
        {categoryOptions(categories).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <Status kind="error">カテゴリを変えられません（{error}）</Status>}
    </>
  )
}

// 選んだ画像のタグ（FR-406、FR-407）。付いているタグを外し、入力したタグを全部に付ける。
// 入力中は、名前に入力した文字を含む既存のタグを候補に出す
export function TagEditor({
  ids,
  tags,
  onCreated,
  onTagged,
  onUntagged,
}: {
  ids: number[]
  tags: Tag[]
  onCreated: (tag: Tag) => void
  onTagged: (tag: number, ids: number[]) => void
  onUntagged: (tag: number, ids: number[]) => void
}) {
  const [on, setOn] = useState<CountedTag[] | null>(null)
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  // 候補のうちキーボードで選んでいるもの。-1 は入力した文字そのもの
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()

  const refresh = useCallback(() => invoke<CountedTag[]>('image_tags', { ids }), [ids])
  useEffect(() => {
    let current = true
    refresh().then(
      (t) => current && setOn(t),
      (e) => current && setError(String(e)),
    )
    return () => {
      current = false
    }
  }, [refresh])

  const run = async (op: Promise<unknown>) => {
    try {
      await op
      setOn(await refresh())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const add = (name: string) =>
    run(
      invoke<Tag>('add_tag', { ids, name }).then((tag) => {
        onCreated(tag)
        onTagged(tag.id, ids)
        setText('')
        setActive(-1)
      }),
    )

  const onAll = new Set((on ?? []).filter((t) => t.count === ids.length).map((t) => t.id))
  const shown = focused ? candidates(tags, text, onAll) : []

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // かな漢字変換を確定する Enter ではタグを付けない（Safari は確定の keydown の isComposing が false で、keyCode が 229 になる）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const by = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (by && shown.length) {
      e.preventDefault()
      // 入力した文字（-1）と候補を順に巡る
      setActive((a) => ((a + 1 + by + shown.length + 1) % (shown.length + 1)) - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const name = shown[active]?.name ?? text
      if (name.trim()) add(name)
    } else if (e.key === 'Escape') {
      setText('')
      setActive(-1)
    }
  }

  return (
    <>
      {on &&
        (on.length ? (
          <ul className="detail__tags">
            {on.map((t) => (
              <li key={t.id} className="tag">
                {t.name}
                {t.count < ids.length && (
                  <span className="tag__count" aria-label={`${ids.length}枚のうち${t.count}枚`}>
                    {t.count}/{ids.length}
                  </span>
                )}
                <button
                  type="button"
                  className="tag__remove"
                  aria-label={`${t.name} を外す`}
                  onClick={() => run(invoke('remove_tag', { ids, tagId: t.id }).then(() => onUntagged(t.id, ids)))}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M7 7l10 10M17 7L7 17" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span>なし</span>
        ))}
      <div className="tag-input">
        <input
          id="detail-tag"
          className={error ? 'tag-input__field tag-input__field--error' : 'tag-input__field'}
          placeholder="タグを追加"
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 && shown[active] ? `${listId}-${active}` : undefined}
          aria-invalid={!!error}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {shown.length > 0 && (
          <ul id={listId} className="tag-input__list" role="listbox" aria-label="既存のタグ">
            {shown.map((t, i) => (
              <li
                key={t.id}
                id={`${listId}-${i}`}
                className="tag-input__option"
                role="option"
                aria-selected={i === active}
                // 押しても入力欄からフォーカスを外さない（外れると候補が消えてクリックが届かない）
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(t.name)}
              >
                {t.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <Status kind="error">タグを変えられません（{error}）</Status>}
    </>
  )
}
