import type { Filter } from './filter'
import type { Category, Tag } from './galleryTypes'

// src-tauri/src/fileops.rs の key と同じく、正規化（NFC）と大文字・小文字の違いを無視して比べる
export const tagKey = (name: string) => name.trim().normalize('NFC').toLowerCase()

// 入力中の文字を名前に含む既存のタグ。選んだ画像のすべてに付いているタグは出さない
export function candidates(tags: Tag[], typed: string, onAll: Set<number>, limit = 8): Tag[] {
  const key = tagKey(typed)
  if (!key) return []
  return tags.filter((t) => !onAll.has(t.id) && tagKey(t.name).includes(key)).slice(0, limit)
}

// カテゴリの選択肢。ツリーの順に、親からの道筋（例：ポーズ / 座り）を名前にする
export function categoryOptions(categories: Category[]): { id: number; label: string }[] {
  const children = new Map<number | null, Category[]>()
  for (const c of categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const walk = (parent: number | null, prefix: string): { id: number; label: string }[] =>
    (children.get(parent) ?? []).flatMap((c) => {
      const label = prefix + c.name
      return [{ id: c.id, label }, ...walk(c.id, `${label} / `)]
    })
  return walk(null, '')
}

// 検索バーの候補（FR-504）。入力した文字を名前に含むカテゴリとタグで、選ぶとそれで絞り込む。
// カテゴリは親からの道筋で探すので、親の名前を入れると子も出る。いま絞り込みに使っているものは出さない
export type FilterCandidate = { kind: 'category' | 'tag'; id: number; label: string }

export function filterCandidates(
  categories: Category[],
  tags: Tag[],
  typed: string,
  filter: Filter,
  limit = 5,
): FilterCandidate[] {
  const key = tagKey(typed)
  if (!key) return []
  const match = (label: string) => tagKey(label).includes(key)
  return [
    ...categoryOptions(categories)
      .filter((c) => c.id !== filter.category && match(c.label))
      .slice(0, limit)
      .map((c) => ({ kind: 'category' as const, ...c })),
    ...tags
      .filter((t) => !filter.tags.includes(t.id) && match(t.name))
      .slice(0, limit)
      .map((t) => ({ kind: 'tag' as const, id: t.id, label: t.name })),
  ]
}

// 候補のうちキーボードで選んでいるもの（-1 は入力した文字そのもの）を、押したキーで動かす。
// 上下キーは端から反対の端へ巡る。Tab と Shift+Tab は端を越えるとき null を返し、次の部品へ移る既定の動きに任せる（候補の中に閉じ込めないため）。
// null は、そのキーを候補の操作に使わないこと
export function moveActive(key: string, shift: boolean, active: number, count: number): number | null {
  if (!count) return null
  const by = { ArrowDown: 1, ArrowUp: -1 }[key]
  if (by) return ((active + 1 + by + count + 1) % (count + 1)) - 1
  if (key !== 'Tab') return null
  const next = active + (shift ? -1 : 1)
  return next >= -1 && next < count ? next : null
}
