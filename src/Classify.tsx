import { invoke } from '@tauri-apps/api/core'
import { type KeyboardEvent, useCallback, useEffect, useId, useState } from 'react'
import { Icon, ICONS } from './icons'
import Status from './Status'
import { candidates, categoryCandidates, categoryOptions, moveActive, recentCandidates } from './choices'
import type { Category, CountedTag, Image, Tag } from './galleryTypes'

// キーボードで選んでいる候補が、一覧のスクロールの外に出ないようにする
function useKeepActiveVisible(listId: string, active: number) {
  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [listId, active])
}

// 選んだ画像（1枚でも複数でも）のカテゴリ（FR-402、FR-407）。入力欄を押すと未分類とすべてのカテゴリを出し、
// 文字を入れると道筋で絞り込む。選ぶとすぐに移す
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
  // 入力中の文字。null は候補を閉じていて、今のカテゴリを出している状態
  const [text, setText] = useState<string | null>(null)
  // 候補のうちキーボードで選んでいるもの。-1 はまだ選んでいない
  const [active, setActive] = useState(-1)
  const listId = useId()
  useKeepActiveVisible(listId, active)
  const first = selected[0].category_id
  const mixed = selected.some((i) => i.category_id !== first)
  const current = mixed ? '' : (categoryOptions(categories).find((o) => o.id === first)?.label ?? '未分類')
  const shown = text === null ? [] : categoryCandidates(categories, text)

  const close = () => {
    setText(null)
    setActive(-1)
  }

  const pick = async (id: number | null) => {
    close()
    setBusy(true)
    try {
      await onAssign(
        selected.map((i) => i.id),
        id,
      )
      setError(null)
    } catch (e) {
      setError(String(e))
    }
    setBusy(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const next = moveActive(e.key, e.shiftKey, active, shown.length)
    if (next !== null) {
      e.preventDefault()
      setActive(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // 上下キーで選んでいなければ、文字を入れたときだけ先頭の候補にする（空の Enter で未分類へ移さない）
      const choice = shown[active] ?? (text?.trim() ? shown[0] : undefined)
      if (choice) pick(choice.id)
    } else if (e.key === 'Escape') {
      close()
    }
  }

  return (
    <>
      <div className="tag-input">
        <input
          autoCorrect="off"
          autoCapitalize="off"
          id="detail-category"
          className={error ? 'tag-input__field tag-input__field--error' : 'tag-input__field'}
          // 入力中は今のカテゴリを薄く出し、何から変えるのかを残す
          placeholder={mixed ? '複数のカテゴリ' : text === null ? '' : current}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 && shown[active] ? `${listId}-${active}` : undefined}
          aria-invalid={!!error}
          disabled={busy}
          value={text ?? current}
          onChange={(e) => {
            setText(e.target.value)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setText('')}
          onClick={() => text === null && setText('')}
          onBlur={close}
        />
        {/* セレクトボックスだったときと同じく、一覧から選べることを山形で示す */}
        <span className="tag-input__chevron">
          <Icon d="M6 9l6 6 6-6" />
        </span>
        {shown.length > 0 && (
          <ul id={listId} className="tag-input__list" role="listbox" aria-label="カテゴリ">
            {shown.map((c, i) => (
              <li
                key={c.id ?? 'none'}
                id={`${listId}-${i}`}
                className="tag-input__option"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c.id)}
              >
                {c.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <Status kind="error">カテゴリを変えられません（{error}）</Status>}
    </>
  )
}

// 選んだ画像のタグ（FR-406、FR-407）。付いているタグを外し、入力したタグを全部に付ける。
// 入力中は、名前に入力した文字を含む既存のタグを候補に出す
export function TagEditor({
  ids,
  tags,
  recent,
  onCreated,
  onTagged,
  onUntagged,
}: {
  ids: number[]
  tags: Tag[]
  // この起動の間に付けたタグの id。新しい順。入力欄の下に出し、押すと付ける
  recent: number[]
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
  useKeepActiveVisible(listId, active)

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
    // タグ管理（FR-408）で名前が変わったり消えたりしたら読み直す
  }, [refresh, tags])

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
  // 付いているタグを読むまでは、どれが付いているか分からないので出さない
  const recents = on ? recentCandidates(tags, recent, onAll) : []

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // かな漢字変換を確定する Enter ではタグを付けない（Safari は確定の keydown の isComposing が false で、keyCode が 229 になる）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const next = moveActive(e.key, e.shiftKey, active, shown.length)
    if (next !== null) {
      e.preventDefault()
      setActive(next)
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
          autoCorrect="off"
          autoCapitalize="off"
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
      {recents.length > 0 && (
        <ul className="tag-recent" aria-label="最近使ったタグ">
          {recents.map((t) => (
            <li key={t.id}>
              <button type="button" className="tag-recent__item" onClick={() => add(t.name)}>
                <Icon d={ICONS.plus} size={12} />
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <Status kind="error">タグを変えられません（{error}）</Status>}
    </>
  )
}
