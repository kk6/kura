import { describe, expect, test } from 'vitest'
import { layout, neighbor, visible } from './layout'

const size = (width: number, height: number) => ({ width, height })

describe('layout', () => {
  test('画像を並び順のとおりに、一番短い列へ順に置く', () => {
    // 幅 100 の列が3つ（100*3 + 間隔10*2 = 320）
    const l = layout([size(100, 300), size(100, 100), size(100, 100), size(100, 100), size(100, 50)], 320, 100, 10)

    expect(l.columnWidth).toBe(100)
    expect([...l.x]).toEqual([0, 110, 220, 110, 220])
    expect([...l.y]).toEqual([0, 0, 0, 110, 110])
    expect(l.columns).toEqual([[0], [1, 3], [2, 4]])
    // 一番下は 1列目の 300（間隔は数えない）
    expect(l.height).toBe(300)
  })

  test('縦横比を保って列の幅に合わせる', () => {
    const l = layout([size(320, 480), size(320, 160)], 200, 200, 6)

    expect([...l.h]).toEqual([300, 100])
  })

  test('列の数は列の幅の目安に一番近い数にし、少なくとも1列にする', () => {
    expect(layout([], 1000, 190, 10).columns).toHaveLength(5)
    expect(layout([], 50, 200, 6).columns).toHaveLength(1)
  })

  test('同じ高さの列が複数あれば左の列に置く', () => {
    const l = layout([size(1, 1), size(1, 1)], 210, 100, 10)

    expect(l.columns).toEqual([[0], [1]])
  })

  test('画像がなければ高さは 0', () => {
    expect(layout([], 300, 100, 10).height).toBe(0)
  })
})

describe('visible', () => {
  // 1列に高さ 100 の画像を10枚、間隔 10 で並べる。i 番目は y = 110i から 110i + 100
  const l = layout(Array.from({ length: 10 }, () => size(100, 100)), 100, 100, 10)

  test('範囲に一部でもかかる画像だけを返す', () => {
    expect(visible(l, 250, 450)).toEqual([2, 3, 4])
  })

  test('範囲の端が画像の端にちょうど重なる画像も返す', () => {
    expect(visible(l, 100, 220)).toEqual([0, 1, 2])
  })

  test('間隔にだけかかる範囲では何も返さない', () => {
    expect(visible(l, 101, 109)).toEqual([])
  })

  test('全体より外の範囲を含めてもはみ出さない', () => {
    expect(visible(l, -500, 5000)).toHaveLength(10)
    expect(visible(l, 2000, 3000)).toEqual([])
  })

  test('列ごとに探して、すべての列の画像を返す', () => {
    const two = layout([size(1, 1), size(1, 2), size(1, 1), size(1, 1)], 210, 100, 10)
    // 列0：0（0〜100）、2（110〜210）。列1：1（0〜200）、3（210〜310）
    expect(visible(two, 150, 205).sort()).toEqual([1, 2])
  })
})

describe('neighbor', () => {
  // 列は [0], [1, 3], [2, 4]
  const l = layout([size(100, 300), size(100, 100), size(100, 100), size(100, 100), size(100, 50)], 320, 100, 10)

  test('左右は並び順の前後に移り、端では止まる', () => {
    expect(neighbor(l, 3, 'ArrowLeft')).toBe(2)
    expect(neighbor(l, 3, 'ArrowRight')).toBe(4)
    expect(neighbor(l, 0, 'ArrowLeft')).toBeUndefined()
    expect(neighbor(l, 4, 'ArrowRight')).toBeUndefined()
  })

  test('上下は同じ列の上下の画像に移り、端では止まる', () => {
    expect(neighbor(l, 1, 'ArrowDown')).toBe(3)
    expect(neighbor(l, 4, 'ArrowUp')).toBe(2)
    expect(neighbor(l, 3, 'ArrowDown')).toBeUndefined()
    expect(neighbor(l, 0, 'ArrowUp')).toBeUndefined()
  })
})
