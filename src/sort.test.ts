import { describe, expect, test } from 'vitest'
import type { Image } from './galleryTypes'
import { sortImages } from './sort'

const image = (id: number, fields: Partial<Image> = {}): Image => ({
  id,
  file_name: `${id}.jpg`,
  hash: String(id),
  width: 1,
  height: 1,
  color: '',
  category_id: null,
  rating: 0,
  imported_at: 0,
  ...fields,
})

const ids = (images: Image[]) => images.map((i) => i.id)

describe('sortImages', () => {
  test('取り込み日は新しい順。同じ日時なら後から登録した順', () => {
    const images = [image(1, { imported_at: 10 }), image(2, { imported_at: 30 }), image(3, { imported_at: 10 })]
    expect(ids(sortImages(images, 'imported'))).toEqual([2, 3, 1])
  })

  test('ファイル名は名前順で、数字は数の大きさで比べる', () => {
    const images = [
      image(1, { file_name: 'ref_10.jpg' }),
      image(2, { file_name: 'ref_2.jpg' }),
      image(3, { file_name: 'Ref_3.jpg' }),
      image(4, { file_name: 'あ.jpg' }),
    ]
    expect(ids(sortImages(images, 'name'))).toEqual([2, 3, 1, 4])
  })

  test('評価は高い順。同じ評価なら取り込み日の新しい順', () => {
    const images = [
      image(1, { rating: 3, imported_at: 1 }),
      image(2, { rating: 5 }),
      image(3, { rating: 3, imported_at: 2 }),
      image(4),
    ]
    expect(ids(sortImages(images, 'rating'))).toEqual([2, 3, 1, 4])
  })

  test('ランダムはすべての画像を1回ずつ含み、与えた乱数で順番が決まる', () => {
    const images = [1, 2, 3, 4, 5].map((id) => image(id))
    const zero = () => 0
    expect(ids(sortImages(images, 'random', zero))).toEqual([2, 3, 4, 5, 1])
    expect(ids(sortImages(images, 'random')).sort()).toEqual([1, 2, 3, 4, 5])
  })

  test('元の配列は並べ替えない', () => {
    const images = [image(1, { imported_at: 1 }), image(2, { imported_at: 2 })]
    sortImages(images, 'imported')
    expect(ids(images)).toEqual([1, 2])
  })
})
