import { subtree } from './categoryTree'
import type { Category, Image } from './galleryTypes'

// 絞り込みの条件（FR-504）。並べ替えと同じく、DB に問い合わせ直さず画面側で絞る
export type Filter = {
  // all はすべての画像、uncategorized は未分類、数はそのカテゴリと子孫
  category: 'all' | 'uncategorized' | number
  tags: number[]
  mode: 'and' | 'or'
  // ファイル名かメモに含む文字。空白で区切った語はすべてを含む
  text: string
}

export const NO_FILTER: Filter = { category: 'all', tags: [], mode: 'and', text: '' }

// 正規化（NFC）と大文字・小文字の違いを無視して比べる
const fold = (s: string) => s.normalize('NFC').toLowerCase()

export function filterImages(images: readonly Image[], categories: Category[], filter: Filter): Image[] {
  const { category, tags, mode } = filter
  const inCategory = typeof category === 'number' ? subtree(categories, category) : null
  const words = fold(filter.text).split(/\s+/).filter(Boolean)
  return images.filter((i) => {
    if (category === 'uncategorized' && i.category_id !== null) return false
    if (inCategory && (i.category_id === null || !inCategory.has(i.category_id))) return false
    if (tags.length && !(mode === 'and' ? tags.every((t) => i.tags.includes(t)) : tags.some((t) => i.tags.includes(t))))
      return false
    if (!words.length) return true
    const hay = fold(`${i.file_name}\n${i.memo}`)
    return words.every((w) => hay.includes(w))
  })
}

// サイドバーの件数。カテゴリは子孫のカテゴリの画像を含める（FR-504）
export function countImages(images: readonly Image[], categories: Category[]) {
  const parent = new Map(categories.map((c) => [c.id, c.parent_id]))
  const out = { categories: new Map<number, number>(), tags: new Map<number, number>(), uncategorized: 0 }
  for (const i of images) {
    if (i.category_id === null) out.uncategorized++
    for (let c: number | null = i.category_id; c !== null; c = parent.get(c) ?? null)
      out.categories.set(c, (out.categories.get(c) ?? 0) + 1)
    for (const t of i.tags) out.tags.set(t, (out.tags.get(t) ?? 0) + 1)
  }
  return out
}
