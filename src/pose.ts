// 拡大表示に重ねる骨格（FR-606）。image_pose が返す関節を、SVG に描く線と点にする
import type { Skip } from './similarity'
import type { Size } from './zoomView'

// image_pose の返り値。ポーズがなければ people は空で、skipped に理由が入る
export type PoseOf = { people: number[][]; skipped: Skip | null }

export type Point = { x: number; y: number }

// ワーカーとポーズの比較が使わない関節（スコアがこれ未満）は描かない
const SEEN = 0.3

// COCO 17点のつながり（0 鼻、1・2 目、3・4 耳、5・6 肩、7・8 肘、9・10 手首、11・12 腰、13・14 膝、15・16 足首。奇数が左）
const BONES: [number, number][] = [
  [15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [6, 8],
  [7, 9], [8, 10], [1, 2], [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6],
] // prettier-ignore

// 関節の座標の入れ物の大きさ。ワーカーはサムネイルの長い辺で割っているので、長い辺を1にする。
// SVG の viewBox にすると、関節の座標をそのまま描ける
export function poseBox({ width, height }: Size): Size {
  const long = Math.max(width, height)
  return { width: width / long, height: height / long }
}

// people は人物ごとに [x, y, スコア] × 17
export function skeleton(people: number[][]) {
  const lines: [Point, Point][] = []
  const joints: Point[] = []
  for (const p of people) {
    const at = (j: number) => (p[3 * j + 2] >= SEEN ? { x: p[3 * j], y: p[3 * j + 1] } : null)
    for (let j = 0; j < 17; j++) {
      const q = at(j)
      if (q) joints.push(q)
    }
    for (const [a, b] of BONES) {
      const [qa, qb] = [at(a), at(b)]
      if (qa && qb) lines.push([qa, qb])
    }
  }
  return { lines, joints }
}
