import { toHiragana } from 'wanakana'
import type { Filter } from './filter'
import type { Category, Tag } from './galleryTypes'

// src-tauri/src/fileops.rs の key と同じく、正規化（NFC）と大文字・小文字の違いを無視して比べる
export const tagKey = (name: string) => name.trim().normalize('NFC').toLowerCase()

// カタカナをひらがなにする（src-tauri/src/tag.rs の reading と同じ）。ローマ字と漢字はそのまま
const hira = (s: string) => s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))

// 入力した文字を、名前か読み仮名に含むか（FR-418）。カタカナとひらがなは同じものとして比べる。
// ローマ字は wanakana でひらがなに直しても照らす。かなにならない末尾（打ち途中の「suwar」の「r」）は除く
export function matches(typed: string, name: string, reading = ''): boolean {
  const key = hira(tagKey(typed))
  if (!key) return false
  const romaji = toHiragana(key).replace(/[a-z]+$/, '')
  const targets = [hira(tagKey(name)), hira(tagKey(reading))]
  return targets.some((t) => t.includes(key) || (romaji !== '' && romaji !== key && t.includes(romaji)))
}

// 入力中の文字を名前に含む既存のタグ。選んだ画像のすべてに付いているタグは出さない。
// 何も入れていなければ一覧から選べるよう、件数を絞らずに全部を返す（並びは読み込んだ順＝名前の順）
export function candidates(tags: Tag[], typed: string, onAll: Set<number>, limit = 8): Tag[] {
  const rest = tags.filter((t) => !onAll.has(t.id))
  return tagKey(typed) ? rest.filter((t) => matches(typed, t.name, t.reading)).slice(0, limit) : rest
}

// サイドバーのタグ一覧の絞り込み（FR-518）。入力した文字を名前に含むタグを、元の順のまま返す。
// keep（選んでいるタグと除いているタグ）は名前に含まなくても返す。何で絞り込んでいるかが見えなくならないように
export function tagsByName(tags: Tag[], typed: string, keep: Set<number>): Tag[] {
  return tagKey(typed) ? tags.filter((t) => keep.has(t.id) || matches(typed, t.name, t.reading)) : tags
}

// 最近使ったタグ（詳細パネル）。id を使った新しい順に持ち、使ったタグを先頭へ移す
export const rememberTag = (recent: number[], id: number) => [id, ...recent.filter((r) => r !== id)]

// 最近使ったタグを出す件数の選択肢（FR-419）。手で書き換えた設定ファイルの値は初めの 5 に戻す
export const RECENT_TAG_COUNTS = [5, 10, 15]
export const recentLimit = (count: number) => (RECENT_TAG_COUNTS.includes(count) ? count : RECENT_TAG_COUNTS[0])

// 最近使ったタグのうち、まだあり、選んだ画像のすべてには付いていないもの
export function recentCandidates(tags: Tag[], recent: number[], onAll: Set<number>, limit = 5): Tag[] {
  const byId = new Map(tags.map((t) => [t.id, t]))
  return recent
    .filter((id) => !onAll.has(id))
    .flatMap((id) => byId.get(id) ?? [])
    .slice(0, limit)
}

// カテゴリの選択肢。ツリーの順に、親からの道筋（例：ポーズ / 座り）を名前にする
export function categoryOptions(categories: Category[]): { id: number; label: string }[] {
  return categoryPaths(categories).map(({ id, label }) => ({ id, label }))
}

// categoryOptions に、道筋の読み（読み仮名がなければ名前）を添えたもの。読み仮名で照らすため（FR-418）
function categoryPaths(categories: Category[]): { id: number; label: string; reading: string }[] {
  const children = new Map<number | null, Category[]>()
  for (const c of categories) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c])
  const walk = (
    parent: number | null,
    prefix: string,
    rprefix: string,
  ): { id: number; label: string; reading: string }[] =>
    (children.get(parent) ?? []).flatMap((c) => {
      const label = prefix + c.name
      const reading = rprefix + (c.reading || c.name)
      return [{ id: c.id, label, reading }, ...walk(c.id, `${label} / `, `${reading} / `)]
    })
  return walk(null, '', '')
}

// 詳細パネルのカテゴリの候補。未分類（id が null）とツリーの順のカテゴリのうち、入力した文字を道筋に含むもの。
// 何も入れていなければ全部を返す
// uncategorized が false なら未分類を出さない（カテゴリの統合の統合先。FR-417）
export function categoryCandidates(
  categories: Category[],
  typed: string,
  uncategorized = true,
): { id: number | null; label: string }[] {
  const all = [...(uncategorized ? [{ id: null, label: '未分類', reading: '' }] : []), ...categoryPaths(categories)]
  const shown = tagKey(typed) ? all.filter((c) => matches(typed, c.label, c.reading)) : all
  return shown.map(({ id, label }) => ({ id, label }))
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
  if (!tagKey(typed)) return []
  return [
    ...categoryPaths(categories)
      .filter(
        (c) =>
          c.id !== filter.category && !filter.excludeCategories.includes(c.id) && matches(typed, c.label, c.reading),
      )
      .slice(0, limit)
      .map((c) => ({ kind: 'category' as const, id: c.id, label: c.label })),
    ...tags
      .filter(
        (t) => !filter.tags.includes(t.id) && !filter.excludeTags.includes(t.id) && matches(typed, t.name, t.reading),
      )
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
