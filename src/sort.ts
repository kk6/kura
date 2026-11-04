import type { Image } from './galleryTypes'

// 並べ替え（FR-506）。2万枚でも数十ミリ秒で済むので、DB に問い合わせ直さず画面側で並べる
export const SORTS = {
  imported: '取り込み日',
  name: 'ファイル名',
  rating: '評価',
  random: 'ランダム',
} as const

export type SortKey = keyof typeof SORTS

// Finder と同じく、ファイル名の中の数字は数の大きさで比べる
const collator = new Intl.Collator('ja', { numeric: true })

const byImported = (a: Image, b: Image) => b.imported_at - a.imported_at || b.id - a.id

const compare: Record<Exclude<SortKey, 'random'>, (a: Image, b: Image) => number> = {
  imported: byImported,
  name: (a, b) => collator.compare(a.file_name, b.file_name) || a.id - b.id,
  rating: (a, b) => b.rating - a.rating || byImported(a, b),
}

export function sortImages(images: readonly Image[], key: SortKey, random = Math.random): Image[] {
  const out = [...images]
  if (key !== 'random') return out.sort(compare[key])
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
