// src-tauri/src/similar.rs の Similar（similar_images コマンドの返り値）。ids と scores の各配列は同じ長さ・同じ並び。
// scores は観点ごとに、基準画像を除いた全画像で平均0・標準偏差1にそろえた値（5.6 の「重み」）
export type Similar = { aspects: string[]; ids: number[]; scores: number[][]; uncomputed: number }

// 観点の名前（model.json の aspects）→ 重み（0〜100 の整数。FR-602）
export type Weights = Record<string, number>

export const WEIGHT_MAX = 100
// 初期値はどの観点も同じ値。上げも下げもできるよう真ん中にする
export const DEFAULT_WEIGHT = 50

// 今の観点の重み。保存した値のうち無い観点を初期値で埋め、範囲に収める。知らない観点の保存した値は呼び手が残す
export function fillWeights(aspects: readonly string[], saved: Weights): Weights {
  const w = Object.fromEntries(
    aspects.map((a) => [a, Math.round(Math.min(WEIGHT_MAX, Math.max(0, saved[a] ?? DEFAULT_WEIGHT)))]),
  )
  return aspects.some((a) => w[a] > 0) ? w : Object.fromEntries(aspects.map((a) => [a, DEFAULT_WEIGHT]))
}

// 全部を0にはできないので、ほかが全部0なら最後の1つは1で止める
export function changeWeight(weights: Weights, aspect: string, value: number): Weights {
  const others = Object.entries(weights).some(([a, v]) => a !== aspect && v > 0)
  return { ...weights, [aspect]: others ? value : Math.max(1, value) }
}

// 観点ごとの値に重みを掛けて足した大きい順の id。基準画像は値によらず先頭に置く
export function rankSimilar(s: Similar & { base: number }, weights: Weights): number[] {
  const w = s.aspects.map((a) => weights[a] ?? 0)
  const total = s.ids.map((_, i) => s.scores.reduce((sum, row, k) => sum + row[i] * w[k], 0))
  const order = s.ids.flatMap((id, i) => (id === s.base ? [] : [i]))
  order.sort((a, b) => total[b] - total[a] || s.ids[a] - s.ids[b])
  return [s.base, ...order.map((i) => s.ids[i])]
}

// スライダーの名前。知らない観点は名前をそのまま出す
export const ASPECT_LABELS: Record<string, string> = { content: '内容', composition: '構図', pose: 'ポーズ' }
