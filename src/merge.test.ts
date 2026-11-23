import { describe, expect, it } from 'vitest'
import { defaultKeep, unionTags } from './merge'

const image = (
  id: number,
  width: number,
  height: number,
  file_size: number,
  imported_at: number,
  tags: number[] = [],
) => ({
  id,
  width,
  height,
  file_size,
  imported_at,
  tags,
})

describe('defaultKeep', () => {
  it('画素数（幅×高さ）が一番大きい画像を選ぶ。縦横の長さが大きくても画素数の小さい画像は選ばない', () => {
    expect(defaultKeep([image(1, 1000, 100, 9, 1), image(2, 400, 400, 1, 2), image(3, 300, 300, 5, 0)])).toBe(2)
  })

  it('画素数が同じならファイルサイズの大きい方、それも同じなら取り込み日時の古い方を選ぶ', () => {
    expect(defaultKeep([image(1, 200, 100, 5, 1), image(2, 100, 200, 8, 2)])).toBe(2)
    expect(defaultKeep([image(1, 200, 100, 5, 3), image(2, 100, 200, 5, 2), image(3, 200, 100, 5, 4)])).toBe(2)
  })
})

describe('unionTags', () => {
  it('選んだ全部の画像のタグを、重ねずに最初に出た順で合わせる', () => {
    expect(unionTags([image(1, 1, 1, 1, 1, [3, 1]), image(2, 1, 1, 1, 1, []), image(3, 1, 1, 1, 1, [1, 2])])).toEqual([
      3, 1, 2,
    ])
  })
})
