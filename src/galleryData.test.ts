import { describe, expect, test } from 'vitest'
import {
  addCategory,
  addTag,
  dropTag,
  editCategories,
  editImages,
  moveImages,
  named,
  removeCategory,
  removeImages,
  replaceTag,
  swapTag,
} from './galleryData'
import type { Gallery, Image } from './galleryTypes'

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
  memo: '',
  tags: [],
  ...fields,
})

// ポーズ（1）の下に座り（2）、座りの下に椅子（3）。服飾（4）は別の枝
const gallery = (images: Image[] = []): Gallery => ({
  images,
  categories: [
    { id: 3, name: '椅子', parent_id: 2, collapsed: false },
    { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
    { id: 2, name: '座り', parent_id: 1, collapsed: false },
    { id: 4, name: '服飾', parent_id: null, collapsed: false },
  ],
  tags: [
    { id: 10, name: 'あおり' },
    { id: 20, name: '俯瞰' },
  ],
})

describe('画像', () => {
  test('選んだ画像だけを書き換え、ほかの画像は同じ値のまま残す', () => {
    const before = gallery([image(1), image(2), image(3)])
    const after = editImages(before, [1, 3], (i) => ({ ...i, memo: 'メモ' }))
    expect(after.images.map((i) => i.memo)).toEqual(['メモ', '', 'メモ'])
    expect(after.images[1]).toBe(before.images[1])
    expect(before.images[0].memo).toBe('')
  })

  test('移した画像にカテゴリと新しいファイル名を入れ、移せなかった画像は変えない', () => {
    const before = gallery([image(1, { category_id: 4 }), image(2, { category_id: 4 })])
    const after = moveImages(before, [{ id: 1, file_name: '1 (2).jpg' }], 2)
    expect(after.images[0]).toMatchObject({ category_id: 2, file_name: '1 (2).jpg' })
    expect(after.images[1]).toBe(before.images[1])
  })

  test('未分類へ移した画像はカテゴリが null になる', () => {
    const after = moveImages(gallery([image(1, { category_id: 4 })]), [{ id: 1, file_name: '1.jpg' }], null)
    expect(after.images[0].category_id).toBeNull()
  })

  test('ゴミ箱へ移した画像を一覧から外す', () => {
    const after = removeImages(gallery([image(1), image(2), image(3)]), new Set([1, 3]))
    expect(after.images.map((i) => i.id)).toEqual([2])
  })
})

test('失敗した画像はファイル名で示し、一覧にない画像は id で示す', () => {
  const failed = [
    { id: 2, message: '読めません' },
    { id: 9, message: '見つかりません' },
  ]
  expect(named(failed, [image(1), image(2)])).toEqual([
    { file_name: '2.jpg', message: '読めません' },
    { file_name: '9', message: '見つかりません' },
  ])
})

describe('カテゴリ', () => {
  test('選んだカテゴリだけを書き換える', () => {
    const before = gallery()
    const after = editCategories(before, [1, 4], (c) => ({ ...c, collapsed: true }))
    expect(after.categories.filter((c) => c.collapsed).map((c) => c.id)).toEqual([1, 4])
    expect(before.categories.some((c) => c.collapsed)).toBe(false)
  })

  test('新しいカテゴリを末尾に足す', () => {
    const after = addCategory(gallery(), { id: 5, name: '靴', parent_id: 4, collapsed: false })
    expect(after.categories.at(-1)).toEqual({ id: 5, name: '靴', parent_id: 4, collapsed: false })
    expect(after.categories).toHaveLength(5)
  })

  test('削除したカテゴリを子孫ごと外し、別の枝は残す', () => {
    const after = removeCategory(gallery(), 1)
    expect(after.categories.map((c) => c.id)).toEqual([4])
  })
})

describe('タグ', () => {
  test('新しいタグを名前の順に足し、すでにあるタグは足さない', () => {
    const before = gallery()
    const after = addTag(before, { id: 15, name: 'うつ伏せ' })
    expect(after.tags.map((t) => t.id)).toEqual([10, 15, 20])
    expect(addTag(after, { id: 15, name: 'うつ伏せ' })).toBe(after)
  })

  test('名前を変えたタグを置き換え、名前の順に並べ直す', () => {
    const after = replaceTag(gallery(), { id: 10, name: '煽り' })
    expect(after.tags).toEqual([
      { id: 20, name: '俯瞰' },
      { id: 10, name: '煽り' },
    ])
  })

  test('統合元のタグを統合先に付け替え、両方が付いていた画像では1つにする', () => {
    expect(swapTag([10, 30], 10, 20)).toEqual([20, 30])
    expect(swapTag([10, 20], 10, 20)).toEqual([20])
  })

  test('削除したタグを外し、付いていなければ同じ配列を返す', () => {
    expect(swapTag([10, 30], 10, null)).toEqual([30])
    const tags = [30]
    expect(swapTag(tags, 10, null)).toBe(tags)
  })

  test('統合すると元のタグが一覧から消え、画像のタグは統合先に替わる', () => {
    const before = gallery([image(1, { tags: [10] }), image(2, { tags: [10, 20] }), image(3, { tags: [20] })])
    const after = dropTag(before, 10, 20)
    expect(after.tags).toEqual([{ id: 20, name: '俯瞰' }])
    expect(after.images.map((i) => i.tags)).toEqual([[20], [20], [20]])
    expect(after.images[2]).toBe(before.images[2])
  })

  test('削除するとタグが一覧と画像から消える', () => {
    const after = dropTag(gallery([image(1, { tags: [10, 20] })]), 10, null)
    expect(after.tags.map((t) => t.id)).toEqual([20])
    expect(after.images[0].tags).toEqual([20])
  })
})
