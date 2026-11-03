// メイソンリーの配置計算と、表示範囲の画像の検索。
// 画像は並び順のとおりに、一番短い列へ順に置く（FR-501）。

export type Layout = {
  colWidth: number;
  x: Float64Array;
  y: Float64Array;
  h: Float64Array;
  columns: number[][]; // 列ごとの画像の番号。各列の中では y の昇順
  height: number;
};

export function layout(sizes: [number, number][], width: number, targetCol: number, gap: number): Layout {
  const cols = Math.max(1, Math.round((width + gap) / (targetCol + gap)));
  const colWidth = (width - gap * (cols - 1)) / cols;
  const n = sizes.length;
  const x = new Float64Array(n), y = new Float64Array(n), h = new Float64Array(n);
  const bottoms = new Array<number>(cols).fill(0);
  const columns: number[][] = Array.from({ length: cols }, () => []);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = 1; k < cols; k++) if (bottoms[k] < bottoms[c]) c = k;
    x[i] = c * (colWidth + gap);
    y[i] = bottoms[c];
    h[i] = (colWidth * sizes[i][1]) / sizes[i][0];
    bottoms[c] += h[i] + gap;
    columns[c].push(i);
  }
  return { colWidth, x, y, h, columns, height: Math.max(...bottoms) };
}

/** top〜bottom に一部でもかかる画像の番号。列ごとに二分探索する。 */
export function visible(l: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (const col of l.columns) {
    let lo = 0, hi = col.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l.y[col[mid]] + l.h[col[mid]] < top) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < col.length && l.y[col[k]] <= bottom; k++) out.push(col[k]);
  }
  return out;
}
