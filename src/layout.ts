// メイソンリーの配置と、表示範囲にかかる画像の検索（FR-501、NFR-01）。
// 幅と高さは DB の値を使うので、サムネイルを読み込む前に全体の配置が決まる

export type Layout = {
  columnWidth: number
  x: Float64Array
  y: Float64Array
  h: Float64Array
  // 列ごとの画像の番号。各列の中では y の昇順なので、二分探索できる
  columns: number[][]
  height: number
}

/** 画像を並び順のとおりに、一番短い列へ順に置く。列の数は targetWidth に一番近い幅になる数 */
export function layout(
  sizes: readonly { width: number; height: number }[],
  width: number,
  targetWidth: number,
  gap: number,
): Layout {
  const count = Math.max(1, Math.round((width + gap) / (targetWidth + gap)))
  const columnWidth = (width - gap * (count - 1)) / count
  const n = sizes.length
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const h = new Float64Array(n)
  const bottoms = new Array<number>(count).fill(0)
  const columns: number[][] = Array.from({ length: count }, () => [])
  for (let i = 0; i < n; i++) {
    let c = 0
    for (let k = 1; k < count; k++) if (bottoms[k] < bottoms[c]) c = k
    x[i] = c * (columnWidth + gap)
    y[i] = bottoms[c]
    h[i] = (columnWidth * sizes[i].height) / sizes[i].width
    bottoms[c] += h[i] + gap
    columns[c].push(i)
  }
  return { columnWidth, x, y, h, columns, height: Math.max(0, Math.max(...bottoms) - gap) }
}

/** top〜bottom に一部でもかかる画像の番号 */
export function visible(l: Layout, top: number, bottom: number): number[] {
  const out: number[] = []
  for (const column of l.columns) {
    let lo = 0
    let hi = column.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (l.y[column[mid]] + l.h[column[mid]] < top) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < column.length && l.y[column[k]] <= bottom; k++) out.push(column[k])
  }
  return out
}

export type Arrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** 矢印キーで移る先の画像の番号（NFR-12）。左右は並び順の前後、上下は同じ列の上下。端では undefined */
export function neighbor(l: Layout, i: number, key: Arrow): number | undefined {
  const n = l.x.length
  if (key === 'ArrowLeft') return i > 0 ? i - 1 : undefined
  if (key === 'ArrowRight') return i < n - 1 ? i + 1 : undefined
  const column = l.columns.find((c) => c.includes(i))!
  return column[column.indexOf(i) + (key === 'ArrowUp' ? -1 : 1)]
}
