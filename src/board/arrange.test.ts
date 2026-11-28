import { describe, expect, it } from 'vitest'
import { arrange } from './arrange'
import { bounds } from './geometry'
import type { Geometry } from './types'

const g = (x: number, y: number, width: number, height: number, extra: Partial<Geometry> = {}): Geometry => ({
  width,
  height,
  x,
  y,
  scale: 1,
  rotation: 0,
  flipped: false,
  grayscale: false,
  crop: null,
  stack_order: 0,
  ...extra,
})

const box = (geometry: Geometry) => {
  const b = bounds([geometry])!
  // 浮動小数の誤差を丸めて比べる
  const r = (n: number) => Math.round(n * 1e6) / 1e6
  return { left: r(b.left), top: r(b.top), right: r(b.right), bottom: r(b.bottom) }
}

describe('arrange', () => {
  it('上から下、同じ高さなら左から右の順に、左から右へ並べる', () => {
    // 元の範囲は 0〜300 の幅。高さ 50 にそろえると、どれも幅 50 になり1行に収まる
    const out = arrange(
      new Map([
        [1, g(200, 0, 100, 100)],
        [2, g(0, 0, 100, 100)],
        [3, g(100, 200, 100, 100)],
      ]),
      50,
    )
    expect(box(out.get(2)!)).toEqual({ left: 0, top: 0, right: 50, bottom: 50 })
    expect(box(out.get(1)!)).toEqual({ left: 50, top: 0, right: 100, bottom: 50 })
    expect(box(out.get(3)!)).toEqual({ left: 100, top: 0, right: 150, bottom: 50 })
  })

  it('起点は元の範囲の左上にする', () => {
    const out = arrange(
      new Map([
        [1, g(40, 30, 100, 100)],
        [2, g(300, 10, 100, 100)],
      ]),
      100,
    )
    expect(box(out.get(2)!)).toEqual({ left: 40, top: 10, right: 140, bottom: 110 })
    expect(box(out.get(1)!)).toEqual({ left: 140, top: 10, right: 240, bottom: 110 })
  })

  it('元の範囲の幅に収まらない配置は次の行へ送る', () => {
    // 元の範囲の幅は 250。高さ 100 にそろえると、2枚目までで 200、3枚目で 300 になり溢れる
    const out = arrange(
      new Map([
        [1, g(0, 0, 50, 50)],
        [2, g(100, 0, 50, 50)],
        [3, g(200, 0, 50, 50)],
      ]),
      100,
    )
    expect(box(out.get(1)!)).toEqual({ left: 0, top: 0, right: 100, bottom: 100 })
    expect(box(out.get(2)!)).toEqual({ left: 100, top: 0, right: 200, bottom: 100 })
    expect(box(out.get(3)!)).toEqual({ left: 0, top: 100, right: 100, bottom: 200 })
  })

  it('1枚だけなら、元の範囲の左上で高さだけをそろえる', () => {
    const out = arrange(new Map([[1, g(10, 20, 200, 100)]]), 50)
    expect(box(out.get(1)!)).toEqual({ left: 10, top: 20, right: 110, bottom: 70 })
  })

  it('回転した配置は、回した後の外枠で高さをそろえて並べ、回転・反転・トリミングは変えない', () => {
    const crop = { x: 0.25, y: 0, width: 0.5, height: 1 }
    const before = g(0, 0, 200, 100, { rotation: 90, flipped: true, crop, grayscale: true })
    const out = arrange(new Map([[1, before]]), 300)
    const after = out.get(1)!
    expect(after.rotation).toBe(90)
    expect(after.flipped).toBe(true)
    expect(after.grayscale).toBe(true)
    expect(after.crop).toEqual(crop)
    const b = box(after)
    expect(b.bottom - b.top).toBe(300)
    expect({ left: b.left, top: b.top }).toEqual({ left: box(before).left, top: box(before).top })
  })
})
