import { describe, expect, test } from 'vitest'
import { countImages, filterImages, NO_FILTER, selectCategory, selectTags, toggleExclude, type Filter } from './filter'
import type { Image } from './galleryTypes'

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
const categories = [
  { id: 3, name: '椅子', parent_id: 2, collapsed: false },
  { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
  { id: 2, name: '座り', parent_id: 1, collapsed: false },
  { id: 4, name: '服飾', parent_id: null, collapsed: false },
]

const tags = [
  { id: 10, name: 'あおり' },
  { id: 20, name: 'Sitting' },
]

const ids = (images: Image[], filter: Partial<Filter>, children = true) =>
  filterImages(images, categories, tags, { ...NO_FILTER, ...filter }, children).map((i) => i.id)

describe('filterImages', () => {
  const images = [
    image(1, { category_id: 1, tags: [10, 20] }),
    image(2, { category_id: 2, tags: [10] }),
    image(3, { category_id: 3, tags: [20] }),
    image(4, { category_id: 4, tags: [30] }),
    image(5),
  ]

  test('条件がなければ全部を並び順のまま返す', () => {
    expect(ids(images, {})).toEqual([1, 2, 3, 4, 5])
  })

  test('カテゴリで絞ると子孫のカテゴリの画像も含める', () => {
    expect(ids(images, { category: 1 })).toEqual([1, 2, 3])
    expect(ids(images, { category: 2 })).toEqual([2, 3])
    expect(ids(images, { category: 'uncategorized' })).toEqual([5])
  })

  test('子カテゴリを含めないときは、そのカテゴリの直下の画像だけに絞る（FR-516）', () => {
    expect(ids(images, { category: 1 }, false)).toEqual([1])
    expect(ids(images, { category: 2 }, false)).toEqual([2])
    expect(ids(images, { category: 'uncategorized' }, false)).toEqual([5])
    // 文字で探すカテゴリ名は親からの道筋のままにする。切り替えはサイドバーで選んだカテゴリにだけ効く
    expect(ids(images, { text: 'ポーズ' }, false)).toEqual([1, 2, 3])
  })

  test('タグは AND ならすべてが付いた画像、OR ならどれかが付いた画像に絞る', () => {
    expect(ids(images, { tags: [10, 20], mode: 'and' })).toEqual([1])
    expect(ids(images, { tags: [10, 20], mode: 'or' })).toEqual([1, 2, 3])
    expect(ids(images, { tags: [10, 30], mode: 'or', category: 1 })).toEqual([1, 2])
  })

  test('文字はファイル名かメモに含む画像に絞る。空白で区切った語はすべてを含む', () => {
    const named = [
      image(1, { file_name: 'Pose_Sit.jpg' }),
      image(2, { file_name: 'b.jpg', memo: '腕の角度と\n肩の線' }),
      image(3, { file_name: 'pose_stand.png', memo: '肩' }),
    ]
    expect(ids(named, { text: 'POSE' })).toEqual([1, 3])
    expect(ids(named, { text: '肩' })).toEqual([2, 3])
    expect(ids(named, { text: 'pose　肩' })).toEqual([3])
    expect(ids(named, { text: '  ' })).toEqual([1, 2, 3])
  })

  test('文字はタグ名とカテゴリ名（親からの道筋）にも探し、語ごとに別の場所に含んでもよい', () => {
    expect(ids(images, { text: 'sitting' })).toEqual([1, 3])
    // ポーズの下の座り（2）と、その下の椅子（3）の画像も出す
    expect(ids(images, { text: 'ポーズ' })).toEqual([1, 2, 3])
    expect(ids(images, { text: '椅子' })).toEqual([3])
    // 「座り」はカテゴリ名、「あおり」はタグ名
    expect(ids(images, { text: '座り あおり' })).toEqual([2])
  })

  test('濁点を分けて書いた文字でも合わせた文字と同じに探す', () => {
    const named = [image(1, { file_name: 'ポーズ.jpg' })]
    expect(ids(named, { text: 'ポーズ' })).toEqual([1])
  })
})

describe('除く（FR-517）', () => {
  const images = [
    image(1, { category_id: 1, tags: [10, 20] }),
    image(2, { category_id: 2, tags: [10] }),
    image(3, { category_id: 3, tags: [20] }),
    image(4, { category_id: 4, tags: [30] }),
    image(5),
  ]

  test('除くタグが1つでも付いた画像を外し、選んだ条件と組み合わせる', () => {
    expect(ids(images, { excludeTags: [20] })).toEqual([2, 4, 5])
    expect(ids(images, { excludeTags: [20, 30] })).toEqual([2, 5])
    expect(ids(images, { tags: [10], excludeTags: [20] })).toEqual([2])
    expect(ids(images, { category: 1, excludeTags: [10] })).toEqual([3])
  })

  test('除くカテゴリは、子カテゴリを含めるかの切り替えに従って子孫の画像も外す', () => {
    expect(ids(images, { excludeCategories: [2] })).toEqual([1, 4, 5])
    expect(ids(images, { excludeCategories: [2] }, false)).toEqual([1, 3, 4, 5])
    expect(ids(images, { category: 1, excludeCategories: [2] })).toEqual([1])
    expect(ids(images, { tags: [20], mode: 'or', excludeCategories: [1] })).toEqual([])
  })

  test('⌥ で押すたびに除く・戻すが切り替わり、選んでいたタグやカテゴリは選択から外す', () => {
    const picked: Filter = { ...NO_FILTER, category: 2, tags: [10, 20] }
    expect(toggleExclude(picked, 'tag', 20)).toEqual({ ...picked, tags: [10], excludeTags: [20] })
    expect(toggleExclude(toggleExclude(picked, 'tag', 20), 'tag', 20)).toEqual({ ...picked, tags: [10] })
    expect(toggleExclude(picked, 'category', 2)).toEqual({ ...picked, category: 'all', excludeCategories: [2] })
    expect(toggleExclude(picked, 'category', 4)).toEqual({ ...picked, excludeCategories: [4] })
  })

  test('除いているタグやカテゴリを普通に選ぶと、除くから外す', () => {
    const excluded: Filter = { ...NO_FILTER, excludeTags: [10, 20], excludeCategories: [2, 4] }
    expect(selectTags(excluded, [20])).toEqual({ ...excluded, tags: [20], excludeTags: [10] })
    expect(selectCategory(excluded, 4)).toEqual({ ...excluded, category: 4, excludeCategories: [2] })
    expect(selectCategory(excluded, 'all')).toEqual({ ...excluded, category: 'all' })
  })
})

describe('countImages', () => {
  test('カテゴリの件数は子孫のカテゴリの画像を含め、タグの件数は付いている枚数を数える', () => {
    const c = countImages(
      [
        image(1, { category_id: 1, tags: [10, 20] }),
        image(2, { category_id: 3, tags: [10] }),
        image(3, { category_id: 4 }),
        image(4),
      ],
      categories,
      true,
    )
    expect(Object.fromEntries(c.categories)).toEqual({ 1: 2, 2: 1, 3: 1, 4: 1 })
    expect(Object.fromEntries(c.tags)).toEqual({ 10: 2, 20: 1 })
    expect(c.uncategorized).toBe(1)
  })

  test('子カテゴリを含めないときは、カテゴリの件数を直下の画像だけで数える（FR-516）', () => {
    const c = countImages(
      [image(1, { category_id: 1, tags: [10] }), image(2, { category_id: 3, tags: [10] }), image(3)],
      categories,
      false,
    )
    expect(Object.fromEntries(c.categories)).toEqual({ 1: 1, 3: 1 })
    expect(Object.fromEntries(c.tags)).toEqual({ 10: 2 })
    expect(c.uncategorized).toBe(1)
  })
})
