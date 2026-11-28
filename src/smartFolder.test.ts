import { describe, expect, test } from 'vitest'
import { NO_FILTER } from './filter'
import { readSmartFolder, writeSmartFolder, type Saved } from './smartFolder'

const categories = [
  { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
  { id: 2, name: '座り', parent_id: 1, collapsed: false },
]
const tags = [
  { id: 10, name: 'あおり' },
  { id: 11, name: '手' },
]

const saved: Saved = {
  filter: { category: 2, tags: [10], mode: 'or', text: '手 足', excludeTags: [11], excludeCategories: [1] },
  sort: 'rating',
  children: false,
}

describe('スマートフォルダの条件', () => {
  test('保存した絞り込みと並べ替えと子カテゴリを含めるかをそのまま読み戻す', () => {
    expect(readSmartFolder(writeSmartFolder(saved), categories, tags)).toEqual({ saved, dropped: 0 })
  })

  test('足りない項目と形の違う項目は初期値で埋めて読む', () => {
    expect(readSmartFolder('{"filter":{"text":"手","mode":"xor"}}', categories, tags)).toEqual({
      saved: { filter: { ...NO_FILTER, text: '手' }, sort: 'imported', children: true },
      dropped: 0,
    })
    expect(
      readSmartFolder('{"filter":{"tags":"10","category":"どこか"},"sort":"size"}', categories, tags).saved,
    ).toEqual({ filter: NO_FILTER, sort: 'imported', children: true })
    expect(readSmartFolder('{"filter":{"category":"uncategorized"}}', categories, tags).saved.filter.category).toBe(
      'uncategorized',
    )
  })

  test('消えたタグとカテゴリは外し、外した数を返す', () => {
    const json = writeSmartFolder({
      ...saved,
      filter: { ...saved.filter, category: 3, tags: [10, 12], excludeTags: [13], excludeCategories: [1, 4] },
    })
    expect(readSmartFolder(json, categories, tags)).toEqual({
      saved: {
        ...saved,
        filter: { ...saved.filter, category: 'all', tags: [10], excludeTags: [], excludeCategories: [1] },
      },
      dropped: 4,
    })
  })
})
