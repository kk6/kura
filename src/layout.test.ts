import { describe, expect, test } from 'vitest'
import { layout, neighbor, visible, within } from './layout'

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

  test('区切りがあれば、区切りごとに見出しの行を置き、その下から全部の列を同じ高さで始める', () => {
    // 2列。1つ目の組は 0〜2、2つ目の組は 3〜4。見出しの行の高さは 40
    const l = layout([size(100, 300), size(100, 100), size(100, 100), size(100, 100), size(100, 100)], 210, 100, 10, {
      starts: [0, 3],
      header: 40,
    })

    expect([...l.headers]).toEqual([0, 350])
    expect([...l.y]).toEqual([40, 40, 150, 390, 390])
    expect([...l.x]).toEqual([0, 110, 110, 0, 110])
    expect(l.height).toBe(490)
  })
})

describe('visible', () => {
  // 1列に高さ 100 の画像を10枚、間隔 10 で並べる。i 番目は y = 110i から 110i + 100
  const l = layout(
    Array.from({ length: 10 }, () => size(100, 100)),
    100,
    100,
    10,
  )

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

describe('within', () => {
  // 幅 100 の列が3つ。0: (0,0)-(100,300)、1: (110,0)-(210,100)、2: (220,0)-(320,100)、3: (110,110)-(210,210)、4: (220,110)-(320,160)
  const l = layout([size(100, 300), size(100, 100), size(100, 100), size(100, 100), size(100, 50)], 320, 100, 10)

  test('範囲に一部でもかかる画像を、並び順で返す', () => {
    expect(within(l, { left: 150, top: 50, right: 250, bottom: 120 })).toEqual([1, 2, 3, 4])
  })

  test('範囲にかからない列と、範囲より上や下の画像は返さない', () => {
    expect(within(l, { left: 0, top: 220, right: 105, bottom: 260 })).toEqual([0])
    expect(within(l, { left: 105, top: 102, right: 108, bottom: 108 })).toEqual([])
  })

  test('間隔の中だけを囲んでも、どの画像も返さない', () => {
    expect(within(l, { left: 211, top: 0, right: 219, bottom: 300 })).toEqual([])
  })
})
