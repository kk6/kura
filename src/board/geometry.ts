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

// 配置の外枠。回転と切り抜きは後のタスクで足すので、枠をそのまま使う
export function bounds(items: Geometry[]): Box | null {
  if (!items.length) return null
  return items.reduce(
    (b, g) => ({
      left: Math.min(b.left, g.x),
      top: Math.min(b.top, g.y),
      right: Math.max(b.right, g.x + g.width * g.scale),
      bottom: Math.max(b.bottom, g.y + g.height * g.scale),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  )
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

export function intersects(box: Box, g: Geometry): boolean {
  return (
    g.x <= box.right && g.x + g.width * g.scale >= box.left && g.y <= box.bottom && g.y + g.height * g.scale >= box.top
  )
}
