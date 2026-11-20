import { subtree } from './categoryTree'
import { categoryOptions } from './choices'
import type { Category, Image, Tag } from './galleryTypes'

// 絞り込みの条件（FR-504）。並べ替えと同じく、DB に問い合わせ直さず画面側で絞る
export type Filter = {
  // all はすべての画像、uncategorized は未分類、数はそのカテゴリ（子孫を含めるかは filterImages の children）
  category: 'all' | 'uncategorized' | number
  tags: number[]
  mode: 'and' | 'or'
  // ファイル名、メモ、タグ名、カテゴリ名（親からの道筋）のどれかに含む文字。空白で区切った語はすべてを含む
  text: string
  // 除くタグとカテゴリ（FR-517）。1つでも付いた画像、そのカテゴリの画像を外す。選ぶ条件（tags、category）とは重ならない
  excludeTags: number[]
  excludeCategories: number[]
}

export const NO_FILTER: Filter = {
  category: 'all',
  tags: [],
  mode: 'and',
  text: '',
  excludeTags: [],
  excludeCategories: [],
}

// サイドバーで ⌥ を押しながら押す（FR-517）。押すたびに除く・戻すが切り替わる。選んでいたものは選択から外す
export function toggleExclude(filter: Filter, kind: 'tag' | 'category', id: number): Filter {
  if (kind === 'tag')
    return filter.excludeTags.includes(id)
      ? { ...filter, excludeTags: filter.excludeTags.filter((t) => t !== id) }
      : { ...filter, tags: filter.tags.filter((t) => t !== id), excludeTags: [...filter.excludeTags, id] }
  return filter.excludeCategories.includes(id)
    ? { ...filter, excludeCategories: filter.excludeCategories.filter((c) => c !== id) }
    : {
        ...filter,
        category: filter.category === id ? 'all' : filter.category,
        excludeCategories: [...filter.excludeCategories, id],
      }
}

// 普通に選ぶ。除いていたものを選んだら、除くから外す
export const selectTags = (filter: Filter, tags: number[]): Filter => ({
  ...filter,
  tags,
  excludeTags: filter.excludeTags.filter((t) => !tags.includes(t)),
})
export const selectCategory = (filter: Filter, category: Filter['category']): Filter => ({
  ...filter,
  category,
  excludeCategories: filter.excludeCategories.filter((c) => c !== category),
})

// 正規化（NFC）と大文字・小文字の違いを無視して比べる
const fold = (s: string) => s.normalize('NFC').toLowerCase()

// children：選んだカテゴリの子孫の画像も出す（FR-516）。アプリ全体の設定なので、保存しない Filter には入れない
export function filterImages(
  images: readonly Image[],
  categories: Category[],
  tags: Tag[],
  filter: Filter,
  children: boolean,
): Image[] {
  const { category, mode } = filter
  const scope = (id: number) => (children ? subtree(categories, id) : new Set([id]))
  const inCategory = typeof category === 'number' ? scope(category) : null
  const outCategories = new Set(filter.excludeCategories.flatMap((c) => [...scope(c)]))
  const words = fold(filter.text).split(/\s+/).filter(Boolean)
  const tagNames = new Map(tags.map((t) => [t.id, t.name]))
  const paths = new Map(categoryOptions(categories).map((c) => [c.id, c.label]))
  return images.filter((i) => {
    if (category === 'uncategorized' && i.category_id !== null) return false
    if (inCategory && (i.category_id === null || !inCategory.has(i.category_id))) return false
    if (i.category_id !== null && outCategories.has(i.category_id)) return false
    if (filter.excludeTags.some((t) => i.tags.includes(t))) return false
    const want = filter.tags
    if (want.length && !(mode === 'and' ? want.every((t) => i.tags.includes(t)) : want.some((t) => i.tags.includes(t))))
      return false
    if (!words.length) return true
    const names = i.tags.map((t) => tagNames.get(t)).join('\n')
    const hay = fold(`${i.file_name}\n${i.memo}\n${names}\n${i.category_id === null ? '' : paths.get(i.category_id)}`)
    return words.every((w) => hay.includes(w))
  })
}

// サイドバーの件数。children なら、カテゴリは子孫のカテゴリの画像を含める（FR-504、FR-516）
export function countImages(images: readonly Image[], categories: Category[], children: boolean) {
  const parent = new Map(categories.map((c) => [c.id, c.parent_id]))
  const out = { categories: new Map<number, number>(), tags: new Map<number, number>(), uncategorized: 0 }
  for (const i of images) {
    if (i.category_id === null) out.uncategorized++
    for (let c: number | null = i.category_id; c !== null; c = children ? (parent.get(c) ?? null) : null)
      out.categories.set(c, (out.categories.get(c) ?? 0) + 1)
    for (const t of i.tags) out.tags.set(t, (out.tags.get(t) ?? 0) + 1)
  }
  return out
}
