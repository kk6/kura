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
  it('上から下、同じ高さなら左から右の順に、16 の隙間を空けて左から右へ並べる', () => {
    const out = arrange(
      new Map([
        [1, g(200, 0, 50, 50)],
        [2, g(0, 0, 50, 50)],
        [3, g(100, 200, 50, 50)],
      ]),
    )
    expect(box(out.get(2)!)).toEqual({ left: 0, top: 0, right: 50, bottom: 50 })
    expect(box(out.get(1)!)).toEqual({ left: 66, top: 0, right: 116, bottom: 50 })
    expect(box(out.get(3)!)).toEqual({ left: 132, top: 0, right: 182, bottom: 50 })
  })

  it('高さを外枠の高さの中央値にそろえる', () => {
    const out = arrange(
      new Map([
        [1, g(0, 0, 50, 50)],
        [2, g(0, 100, 100, 100)],
        [3, g(0, 300, 400, 400)],
      ]),
    )
    for (const id of [1, 2, 3]) {
      const b = box(out.get(id)!)
      expect(b.bottom - b.top).toBe(100)
    }
  })

  it('起点は元の範囲の左上にする', () => {
    const out = arrange(
      new Map([
        [1, g(40, 30, 100, 100)],
        [2, g(300, 10, 100, 100)],
      ]),
    )
    expect(box(out.get(2)!)).toEqual({ left: 40, top: 10, right: 140, bottom: 110 })
    expect(box(out.get(1)!)).toEqual({ left: 156, top: 10, right: 256, bottom: 110 })
  })

  it('元の範囲の幅に収まらない配置は、16 の隙間を空けて次の行へ送る', () => {
    // 元の範囲の幅は 320。3枚目は 232〜332 になり溢れる
    const out = arrange(
      new Map([
        [1, g(0, 0, 100, 100)],
        [2, g(110, 0, 100, 100)],
        [3, g(220, 0, 100, 100)],
      ]),
    )
    expect(box(out.get(2)!)).toEqual({ left: 116, top: 0, right: 216, bottom: 100 })
    expect(box(out.get(3)!)).toEqual({ left: 0, top: 116, right: 100, bottom: 216 })
  })

  it('元の範囲の幅より広い配置は、1行に1枚で置く', () => {
    // 中央値の 100 にそろえると、1枚目は幅 400 になり、元の範囲の幅 300 を超える
    const out = arrange(
      new Map([
        [1, g(0, 0, 200, 50)],
        [2, g(200, 0, 100, 100)],
        [3, g(0, 200, 100, 100)],
      ]),
    )
    expect(box(out.get(1)!)).toEqual({ left: 0, top: 0, right: 400, bottom: 100 })
    expect(box(out.get(2)!)).toEqual({ left: 0, top: 116, right: 100, bottom: 216 })
  })

  it('1枚だけなら、位置も大きさも変わらない', () => {
    const out = arrange(new Map([[1, g(10, 20, 200, 100)]]))
    expect(box(out.get(1)!)).toEqual({ left: 10, top: 20, right: 210, bottom: 120 })
  })

  it('回転した配置は、回した後の外枠で高さをそろえ、回転・反転・トリミング・グレースケールは変えない', () => {
    const crop = { x: 0.25, y: 0, width: 0.75, height: 1 }
    // 切り抜いた 150×100 を90度回すと、外枠は高さ 150。もう1枚の高さ 100 と合わせた中央値は 125
    const rotated = g(0, 0, 200, 100, { rotation: 90, flipped: true, crop, grayscale: true })
    const out = arrange(
      new Map([
        [1, rotated],
        [2, g(500, 300, 100, 100)],
      ]),
    )
    const after = out.get(1)!
    expect(after).toMatchObject({ rotation: 90, flipped: true, grayscale: true, crop })
    const b = box(after)
    expect(b.bottom - b.top).toBe(125)
    expect({ left: b.left, top: b.top }).toEqual({ left: box(rotated).left, top: box(rotated).top })
  })
})
