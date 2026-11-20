import { describe, expect, it } from 'vitest'
import { readDragged } from './imageDrag'

describe('readDragged', () => {
  it('一覧から運んだ画像の ID を読む', () => {
    expect(readDragged('[3,1,2]')).toEqual([3, 1, 2])
  })

  it('空、JSON でない、整数の配列でないデータは画像として読まない', () => {
    for (const raw of ['', 'abc', '[]', '{"a":1}', '[1,"2"]', '[1.5]', '3']) expect(readDragged(raw)).toBeNull()
  })
})
