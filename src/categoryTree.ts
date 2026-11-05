import type { Category } from './galleryTypes'

// id のカテゴリと、その子孫のカテゴリの id
export function subtree(categories: Category[], id: number): Set<number> {
  const ids = new Set([id])
  // 親が子より前に並ぶとは限らないので、増えなくなるまでたどる
  for (let size = 0; size !== ids.size;) {
    size = ids.size
    for (const c of categories) if (c.parent_id !== null && ids.has(c.parent_id)) ids.add(c.id)
  }
  return ids
}
