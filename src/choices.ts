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
