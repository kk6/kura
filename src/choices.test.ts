import { describe, expect, it, test } from 'vitest'
import { candidates, categoryOptions, filterCandidates, moveActive } from './choices'
import { NO_FILTER } from './filter'

const TAGS = [
  { id: 1, name: 'Pose' },
  { id: 2, name: 'ポーズ（座り）' },
  { id: 3, name: '振り返り' },
]

describe('candidates', () => {
  it('入力した文字を含むタグを、大文字・小文字と正規化の違いを無視して返す', () => {
    expect(candidates(TAGS, 'pO', new Set()).map((t) => t.id)).toEqual([1])
    expect(candidates(TAGS, 'ポーズ', new Set()).map((t) => t.id)).toEqual([2])
    expect(candidates(TAGS, ' 返り ', new Set()).map((t) => t.id)).toEqual([3])
  })

  it('選んだ画像のすべてに付いているタグと、空の入力では出さない', () => {
    expect(candidates(TAGS, 'o', new Set([1]))).toEqual([])
    expect(candidates(TAGS, '  ', new Set())).toEqual([])
  })

  it('件数を limit までに絞る', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `タグ${i}` }))
    expect(candidates(many, 'タグ', new Set())).toHaveLength(8)
  })
})

describe('categoryOptions', () => {
  it('ツリーの順に、親からの道筋を名前にする', () => {
    const options = categoryOptions([
      { id: 1, name: 'ポーズ', parent_id: null },
      { id: 4, name: '服飾', parent_id: null },
      { id: 2, name: '座り', parent_id: 1 },
      { id: 3, name: '椅子', parent_id: 2 },
    ])
    expect(options).toEqual([
      { id: 1, label: 'ポーズ' },
      { id: 2, label: 'ポーズ / 座り' },
      { id: 3, label: 'ポーズ / 座り / 椅子' },
      { id: 4, label: '服飾' },
    ])
  })
})

describe('filterCandidates', () => {
  const categories = [
    { id: 1, name: 'ポーズ', parent_id: null },
    { id: 2, name: '座り', parent_id: 1 },
    { id: 3, name: '服飾', parent_id: null },
  ]
  const tags = [
    { id: 10, name: '座り込み' },
    { id: 11, name: 'あおり' },
  ]

  test('入力した文字を名前に含むカテゴリ（親からの道筋）とタグを、カテゴリ、タグの順に出す', () => {
    expect(filterCandidates(categories, tags, '座り', NO_FILTER)).toEqual([
      { kind: 'category', id: 2, label: 'ポーズ / 座り' },
      { kind: 'tag', id: 10, label: '座り込み' },
    ])
    // 親の名前で探すと子も出す
    expect(filterCandidates(categories, tags, 'ポーズ', NO_FILTER).map((c) => c.id)).toEqual([1, 2])
    expect(filterCandidates(categories, tags, '  ', NO_FILTER)).toEqual([])
  })

  test('いま絞り込みに使っているカテゴリとタグは出さない', () => {
    const filter = { ...NO_FILTER, category: 2, tags: [10] }
    expect(filterCandidates(categories, tags, '座り', filter)).toEqual([])
  })

  test('カテゴリとタグはそれぞれ5件までにする', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: i, name: `t${i}` }))
    expect(filterCandidates([], many, 't', NO_FILTER)).toHaveLength(5)
  })
})

describe('moveActive', () => {
  // 候補が3件。-1 は入力した文字そのもの
  const move = (key: string, active: number, shift = false) => moveActive(key, shift, active, 3)

  test('上下キーは入力した文字と候補を巡る', () => {
    expect([move('ArrowDown', -1), move('ArrowDown', 2), move('ArrowUp', -1), move('ArrowUp', 0)]).toEqual([0, -1, 2, -1])
  })

  test('Tab は次の候補、Shift+Tab は前の候補へ移り、端を越えるときは候補の操作に使わない', () => {
    expect([move('Tab', -1), move('Tab', 1), move('Tab', 0, true), move('Tab', 0, true)]).toEqual([0, 2, -1, -1])
    expect(move('Tab', 2)).toBeNull()
    expect(move('Tab', -1, true)).toBeNull()
  })

  test('候補がないときとほかのキーは候補の操作に使わない', () => {
    expect(moveActive('ArrowDown', false, -1, 0)).toBeNull()
    expect(moveActive('Tab', false, -1, 0)).toBeNull()
    expect(move('Enter', 0)).toBeNull()
  })
})
