// 拡大表示の中の拡大・縮小と移動（FR-508）。倍率は枠に合わせた大きさを 1 とし、
// x、y は画像の中央が枠の中央からずれている量（画面のポイント）。画面の計算だけで、DB には残さない
export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type View = { zoom: number; x: number; y: number }

export const FIT: View = { zoom: 1, x: 0, y: 0 }
// 原寸（画像の1ピクセルを画面の1ポイント）に対する倍率の上限
const MAX_SCALE = 8

const fitScale = (image: Size, frame: Size) => Math.min(frame.width / image.width, frame.height / image.height)
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max)

// 画像の1ピクセルを画面の何ポイントで出しているか。100% の表示に使う
export const scaleOf = (v: View, image: Size, frame: Size) => fitScale(image, frame) * v.zoom

// 大きい画像は枠に合わせた大きさより小さくしない。小さい画像は原寸まで小さくできる。上限は原寸の 800%
export function zoomRange(image: Size, frame: Size) {
  const fit = fitScale(image, frame)
  return { min: Math.min(1, 1 / fit), max: Math.max(1, MAX_SCALE / fit) }
}

// 倍率を範囲に収め、画像が枠より大きい向きは端が枠の内側に入らないように、枠以下の向きは中央に置く
export function clampView(v: View, image: Size, frame: Size): View {
  const { min, max } = zoomRange(image, frame)
  const zoom = clamp(v.zoom, min, max)
  const scale = fitScale(image, frame) * zoom
  const limitX = Math.max(0, (image.width * scale - frame.width) / 2)
  const limitY = Math.max(0, (image.height * scale - frame.height) / 2)
  // -0 を 0 にそろえる（比べるときに食い違わないように）
  return { zoom, x: clamp(v.x, -limitX, limitX) || 0, y: clamp(v.y, -limitY, limitY) || 0 }
}

// point（枠の中央から測った位置）の下に見えている画像の点を動かさずに、倍率に factor をかける
export function zoomViewAt(v: View, image: Size, frame: Size, point: Point, factor: number): View {
  const { min, max } = zoomRange(image, frame)
  const zoom = clamp(v.zoom * factor, min, max)
  const k = zoom / v.zoom
  return clampView({ zoom, x: point.x - (point.x - v.x) * k, y: point.y - (point.y - v.y) * k }, image, frame)
}

export const panView = (v: View, image: Size, frame: Size, dx: number, dy: number) =>
  clampView({ ...v, x: v.x + dx, y: v.y + dy }, image, frame)

// 原寸にする。今見ている枠の中央の点は動かさない（プレビューの「実際のサイズ」と同じ）
export const actualSize = (v: View, image: Size, frame: Size) =>
  zoomViewAt(v, image, frame, { x: 0, y: 0 }, 1 / scaleOf(v, image, frame))
