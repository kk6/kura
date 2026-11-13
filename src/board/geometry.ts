import type { Geometry, Viewport } from './types'

// ボード上の四角。配置の外枠や範囲選択に使う
export type Box = { left: number; top: number; right: number; bottom: number }
export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
// 選択枠の四隅。n・s は上下、w・e は左右
export type Corner = 'nw' | 'ne' | 'sw' | 'se'

// 表示の倍率の範囲。Rust は 0 以下を断るので、下限を正の値にする
export const MIN_ZOOM = 0.01
export const MAX_ZOOM = 64

const rotate = (p: Point, about: Point, degrees: number): Point => {
  const r = (degrees * Math.PI) / 180
  const [dx, dy] = [p.x - about.x, p.y - about.y]
  return { x: about.x + dx * Math.cos(r) - dy * Math.sin(r), y: about.y + dx * Math.sin(r) + dy * Math.cos(r) }
}

// 回転の中心。切り抜いていても、枠（元画像の全体）の中心で回す。Rust の bounds と同じ
const pivot = (g: Geometry): Point => ({ x: g.x + (g.width * g.scale) / 2, y: g.y + (g.height * g.scale) / 2 })

// 描く範囲。回転の前の、ボード上の四角。切り抜きは反転の前の元画像に対する割合なので、反転していれば左右を入れ替える
export function visible(g: Geometry): Box {
  const [w, h] = [g.width * g.scale, g.height * g.scale]
  const c = g.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const left = g.x + (g.flipped ? 1 - c.x - c.width : c.x) * w
  const top = g.y + c.y * h
  return { left, top, right: left + c.width * w, bottom: top + c.height * h }
}

// 描く範囲の中心が、回転の後に来る所
export function centerOf(g: Geometry): Point {
  const v = visible(g)
  return rotate({ x: (v.left + v.right) / 2, y: (v.top + v.bottom) / 2 }, pivot(g), g.rotation)
}

const cornersOf = (box: Box): Point[] => [
  { x: box.left, y: box.top },
  { x: box.right, y: box.top },
  { x: box.right, y: box.bottom },
  { x: box.left, y: box.bottom },
]

const around = (points: Point[]): Box => ({
  left: Math.min(...points.map((p) => p.x)),
  top: Math.min(...points.map((p) => p.y)),
  right: Math.max(...points.map((p) => p.x)),
  bottom: Math.max(...points.map((p) => p.y)),
})

// 配置の外枠。描く範囲を回した後の四隅を囲む
export function bounds(items: Geometry[]): Box | null {
  if (!items.length) return null
  return around(items.flatMap((g) => cornersOf(visible(g)).map((p) => rotate(p, pivot(g), g.rotation))))
}

// next を、描く範囲の中心が g と同じ所に来るようにずらす。切り抜いた配置は枠の中心で回るので、
// ずらさないと、回転や反転のたびに見えている部分が別の所へ飛ぶ
export function pinned(g: Geometry, next: Geometry): Geometry {
  const [from, to] = [centerOf(g), centerOf(next)]
  return { ...next, x: next.x + from.x - to.x, y: next.y + from.y - to.y }
}

// 見えている部分をその場で回して rotation 度にする
export function turned(g: Geometry, rotation: number): Geometry {
  return pinned(g, { ...g, rotation: ((rotation % 360) + 360) % 360 })
}

// Shift を押している間の回転の刻み（FR-706）
export const snap = (degrees: number) => Math.round(degrees / 15) * 15

// about から見た point の向き（度）。画面と同じく、右回りが正
export const angleOf = (about: Point, point: Point) =>
  (Math.atan2(point.y - about.y, point.x - about.x) * 180) / Math.PI

// ボード上の2点 a・b を対角にした四角を、g の切り抜き（反転・回転の前の元画像に対する 0〜1 の四角）に直す。
// 画像の外は切り捨てる。画像に掛からなければ null
export function cropOf(g: Geometry, a: Point, b: Point): NonNullable<Geometry['crop']> | null {
  const unit = (p: Point) => {
    const local = rotate(p, pivot(g), -g.rotation)
    const x = Math.min(Math.max((local.x - g.x) / (g.width * g.scale), 0), 1)
    return { x: g.flipped ? 1 - x : x, y: Math.min(Math.max((local.y - g.y) / (g.height * g.scale), 0), 1) }
  }
  const box = around([unit(a), unit(b)])
  const crop = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
  return crop.width > 0 && crop.height > 0 ? crop : null
}

const clampZoom = (scale: number) => Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM)

// 枠の全体が、端から margin を空けて見える表示
export function fitView(box: Box, size: Size, margin: number): Viewport {
  const scale = Math.min(
    (size.width - margin * 2) / (box.right - box.left),
    (size.height - margin * 2) / (box.bottom - box.top),
  )
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, scale: clampZoom(scale) }
}

// キャンバスの左上から測った画面の点を、ボード上の点に直す
export function toBoard(v: Viewport, size: Size, point: Point): Point {
  return { x: v.x + (point.x - size.width / 2) / v.scale, y: v.y + (point.y - size.height / 2) / v.scale }
}

// point の下に見えているボード上の点を動かさずに、倍率に factor をかける（FR-703）
export function zoomAt(v: Viewport, size: Size, point: Point, factor: number): Viewport {
  const scale = clampZoom(v.scale * factor)
  const at = toBoard(v, size, point)
  return { x: at.x - (point.x - size.width / 2) / scale, y: at.y - (point.y - size.height / 2) / scale, scale }
}

// corner の向かいの角。拡大・縮小で動かさない点
export function anchorOf(box: Box, corner: Corner): Point {
  return { x: corner.includes('w') ? box.right : box.left, y: corner.includes('n') ? box.bottom : box.top }
}

// corner を pointer まで引いたときの倍率。縦横比を保つため、2つの軸のうち大きいほうを使う（FR-702）
export function resizeFactor(box: Box, corner: Corner, pointer: Point, min: number): number {
  const anchor = anchorOf(box, corner)
  const from = { x: corner.includes('w') ? box.left : box.right, y: corner.includes('n') ? box.top : box.bottom }
  return Math.max((pointer.x - anchor.x) / (from.x - anchor.x), (pointer.y - anchor.y) / (from.y - anchor.y), min)
}

// anchor を動かさずに factor 倍にする。複数の配置に同じ anchor と factor を使うと、相互の位置関係が残る
export function scaleAbout(g: Geometry, anchor: Point, factor: number): Geometry {
  return {
    ...g,
    x: anchor.x + (g.x - anchor.x) * factor,
    y: anchor.y + (g.y - anchor.y) * factor,
    scale: g.scale * factor,
  }
}

const overlaps = (a: Box, b: Box) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top

// 範囲選択の四角が、配置の描く範囲に少しでも重なるか。回した後の外枠だけで比べると、外枠の角にある
// 画像のない所でも選ばれるので、配置の向きに戻した四角とも比べる（四角どうしなので、この2つで足りる）
export function intersects(box: Box, g: Geometry): boolean {
  return (
    overlaps(box, bounds([g])!) &&
    overlaps(around(cornersOf(box).map((p) => rotate(p, pivot(g), -g.rotation))), visible(g))
  )
}
