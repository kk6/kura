import { type Filter, NO_FILTER } from './filter'
import type { Category, Tag } from './galleryTypes'
import { SORTS, type SortKey } from './sort'

// src-tauri/src/smart_folder.rs の SmartFolder。filter は writeSmartFolder の JSON
export type SmartFolder = { id: number; name: string; filter: string }

// スマートフォルダに保存するもの（FR-510）。children（子カテゴリを含めるか、FR-516）はアプリ全体の設定だが、
// 同じ絞り込みにするために一緒に持つ。類似画像検索の結果と隠すモード（FR-513）は持たない
export type Saved = { filter: Filter; sort: SortKey; children: boolean }

export const writeSmartFolder = (saved: Saved) => JSON.stringify(saved)

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [])

// 絞り込みの項目が後で増えても古い JSON を読めるよう、足りない項目と形の違う項目は初期値で埋める。
// 消えたタグとカテゴリは外し、外した数を dropped で返す（ステータスバーで知らせる）
export function readSmartFolder(json: string, categories: Category[], tags: Tag[]): { saved: Saved; dropped: number } {
  let raw: { filter?: Record<string, unknown>; sort?: unknown; children?: unknown } = {}
  try {
    raw = JSON.parse(json) ?? {}
  } catch {
    // Rust が JSON のオブジェクトだけを保存するので、ここへは来ない
  }
  const f = raw.filter ?? {}
  const tagIds = new Set(tags.map((t) => t.id))
  const categoryIds = new Set(categories.map((c) => c.id))
  let dropped = 0
  const keep = (list: number[], known: Set<number>) => {
    const kept = list.filter((id) => known.has(id))
    dropped += list.length - kept.length
    return kept
  }
  let category: Filter['category'] = NO_FILTER.category
  if (f.category === 'uncategorized') category = 'uncategorized'
  else if (typeof f.category === 'number') {
    if (categoryIds.has(f.category)) category = f.category
    else dropped++
  }
  const filter: Filter = {
    category,
    tags: keep(ids(f.tags), tagIds),
    mode: f.mode === 'or' ? 'or' : 'and',
    text: typeof f.text === 'string' ? f.text : NO_FILTER.text,
    excludeTags: keep(ids(f.excludeTags), tagIds),
    excludeCategories: keep(ids(f.excludeCategories), categoryIds),
  }
  const sort = typeof raw.sort === 'string' && raw.sort in SORTS ? (raw.sort as SortKey) : 'imported'
  return { saved: { filter, sort, children: raw.children !== false }, dropped }
}
