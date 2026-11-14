import { subtree } from './categoryTree'
import type { Assigned, Category, Gallery, Image, Tag } from './galleryTypes'
import type { Failed } from './StatusbarResult'

// Rust の操作が終わった後に、手元の一覧（Gallery）へ同じ変更を当てる。絞り込みと件数は手元の値で数えるので、
// 変わった所だけを書き換え、一覧は読み直さない

export const editImages = (d: Gallery, ids: number[], edit: (i: Image) => Image): Gallery => {
  const targets = new Set(ids)
  return { ...d, images: d.images.map((i) => (targets.has(i.id) ? edit(i) : i)) }
}

// 移した画像のカテゴリとファイル名。同じ名前のファイルが移動先にあると、Rust がファイル名を変える
export const moveImages = (d: Gallery, moved: Assigned['moved'], category: number | null): Gallery => {
  const names = new Map(moved.map((m) => [m.id, m.file_name]))
  return {
    ...d,
    images: d.images.map((i) => (names.has(i.id) ? { ...i, category_id: category, file_name: names.get(i.id)! } : i)),
  }
}

export const removeImages = (d: Gallery, gone: Set<number>): Gallery => ({
  ...d,
  images: d.images.filter((i) => !gone.has(i.id)),
})

export const editCategories = (d: Gallery, ids: number[], edit: (c: Category) => Category): Gallery => {
  const targets = new Set(ids)
  return { ...d, categories: d.categories.map((c) => (targets.has(c.id) ? edit(c) : c)) }
}

export const addCategory = (d: Gallery, category: Category): Gallery => ({
  ...d,
  categories: [...d.categories, category],
})

// id のカテゴリを子孫ごと外す
export const removeCategory = (d: Gallery, id: number): Gallery => {
  const gone = subtree(d.categories, id)
  return { ...d, categories: d.categories.filter((c) => !gone.has(c.id)) }
}

const sortTags = (tags: Tag[]) => tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))

export const addTag = (d: Gallery, tag: Tag): Gallery =>
  d.tags.some((t) => t.id === tag.id) ? d : { ...d, tags: sortTags([...d.tags, tag]) }

export const replaceTag = (d: Gallery, tag: Tag): Gallery => ({
  ...d,
  tags: sortTags(d.tags.map((t) => (t.id === tag.id ? tag : t))),
})

// タグの id の並びから from を外す。into があれば代わりに入れる。画像のタグと絞り込みの条件の両方に使う
export const swapTag = (tags: number[], from: number, into: number | null): number[] =>
  tags.includes(from) ? [...new Set(tags.flatMap((t) => (t === from ? (into === null ? [] : [into]) : [t])))] : tags

// from のタグを一覧と画像から外す。into があれば画像には代わりに付ける（統合）
export const dropTag = (d: Gallery, from: number, into: number | null): Gallery => ({
  ...d,
  tags: d.tags.filter((t) => t.id !== from),
  images: d.images.map((i) => (i.tags.includes(from) ? { ...i, tags: swapTag(i.tags, from, into) } : i)),
})

// 失敗した画像を、利用者が見分けられるファイル名で返す。list は操作の前の一覧
export const named = (failed: Assigned['failed'], list: Image[]): Failed =>
  failed.map((f) => ({ file_name: list.find((i) => i.id === f.id)?.file_name ?? String(f.id), message: f.message }))
