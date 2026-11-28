import { bounds, scaleAbout } from './geometry'
import type { Geometry } from './types'

// 整列（FR-709）。配置の外枠（回転の後。選択枠と同じ求め方）の高さを height にそろえ、元の範囲の左上から
// 左から右へ詰めて並べる。行の幅は元の範囲の幅。並べる順は元の外枠の上から下、同じ高さなら左から右。
// 位置と倍率だけを変え、回転・反転・トリミングは変えない
export function arrange(items: Map<number, Geometry>, height: number): Map<number, Geometry> {
  const range = bounds([...items.values()])
  const out = new Map<number, Geometry>()
  if (!range) return out
  const placed = [...items].map(([id, g]) => ({ id, g, b: bounds([g])! }))
  placed.sort((p, q) => p.b.top - q.b.top || p.b.left - q.b.left)
  let [x, y] = [range.left, range.top]
  for (const { id, g, b } of placed) {
    const factor = height / (b.bottom - b.top)
    const width = (b.right - b.left) * factor
    // 行の先頭でなければ、溢れる配置を次の行へ送る。先頭の配置は幅を超えても置く
    if (x > range.left && x + width > range.right) [x, y] = [range.left, y + height]
    // 外枠の左上を止めて倍率を変えると、外枠も同じ左上のまま factor 倍になる
    const scaled = scaleAbout(g, { x: b.left, y: b.top }, factor)
    out.set(id, { ...scaled, x: scaled.x + x - b.left, y: scaled.y + y - b.top })
    x += width
  }
  return out
}
