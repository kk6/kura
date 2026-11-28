import { describe, expect, it, test } from 'vitest'
import {
  candidates,
  categoryCandidates,
  categoryOptions,
  filterCandidates,
  matches,
  moveActive,
  recentCandidates,
  recentLimit,
  rememberTag,
  tagsByName,
} from './choices'
import { NO_FILTER } from './filter'

const TAGS = [
  { id: 1, name: 'Pose' },
  { id: 2, name: 'ポーズ（座り）' },
  { id: 3, name: '振り返り' },
]

describe('matches', () => {
  it('ローマ字・ひらがな・カタカナの入力を、読み仮名を付けた漢字の名前と照らす', () => {
    for (const typed of ['suwari', 'すわり', 'スワリ', 'SUWARI']) expect(matches(typed, '座り', 'すわり')).toBe(true)
    expect(matches('suwari', '座り')).toBe(false)
    expect(matches('tachi', '座り', 'すわり')).toBe(false)
  })

  it('読み仮名のない、ひらがなとカタカナの名前もローマ字で照らす', () => {
    expect(matches('suwari', 'すわり')).toBe(true)
    expect(matches('suwari', 'スワリ')).toBe(true)
    expect(matches('すわり', 'スワリ')).toBe(true)
    expect(matches('po-zu', 'ポーズ（座り）')).toBe(true)
  })

  it('打ち途中のローマ字（かなにならない末尾）でも照らす', () => {
    expect(matches('suwar', '座り', 'すわり')).toBe(true)
    expect(matches('s', 'スワリ')).toBe(false)
  })

  it('ローマ字の名前は今のとおり入力した文字のまま照らす', () => {
    expect(matches('pos', 'Pose')).toBe(true)
    expect(matches('ose', 'Pose')).toBe(true)
  })
})

describe('candidates', () => {
  it('読み仮名でも照らす（FR-418）', () => {
    const tags = [...TAGS, { id: 4, name: '座り', reading: 'すわり' }]
    expect(candidates(tags, 'suwari', new Set()).map((t) => t.id)).toEqual([4])
  })

  it('入力した文字を含むタグを、大文字・小文字と正規化の違いを無視して返す', () => {
    expect(candidates(TAGS, 'oSe', new Set()).map((t) => t.id)).toEqual([1])
    expect(candidates(TAGS, 'ポーズ', new Set()).map((t) => t.id)).toEqual([2])
    expect(candidates(TAGS, ' 返り ', new Set()).map((t) => t.id)).toEqual([3])
  })

  it('選んだ画像のすべてに付いているタグは出さない', () => {
    expect(candidates(TAGS, 'o', new Set([1]))).toEqual([])
  })

  it('空の入力では、選んだ画像のすべてに付いているタグを除いた全部を、件数を絞らずに返す', () => {
    expect(candidates(TAGS, '  ', new Set([2])).map((t) => t.id)).toEqual([1, 3])
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `タグ${i}` }))
    expect(candidates(many, '', new Set())).toHaveLength(20)
  })

  it('件数を limit までに絞る', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `タグ${i}` }))
    expect(candidates(many, 'タグ', new Set())).toHaveLength(8)
  })
})

describe('tagsByName', () => {
  it('入力した文字を名前に含むタグだけを、大文字・小文字と正規化の違いを無視して元の順で返す', () => {
    // 'ポ' を濁点の結合文字（NFD）で書いても、NFC の名前に当たる
    expect(tagsByName(TAGS, 'ホ\u309Aーズ'.normalize('NFD'), new Set()).map((t) => t.id)).toEqual([2])
    expect(tagsByName(TAGS, ' oSe ', new Set()).map((t) => t.id)).toEqual([1])
    expect(tagsByName(TAGS, 'り', new Set()).map((t) => t.id)).toEqual([2, 3])
  })

  it('名前が NFD のタグにも、NFC の入力で当たる', () => {
    const nfd = [{ id: 9, name: 'ポーズ'.normalize('NFD') }]
    expect(tagsByName(nfd, 'ポーズ', new Set()).map((t) => t.id)).toEqual([9])
  })

  it('空の入力では全部を返す', () => {
    expect(tagsByName(TAGS, ' ', new Set())).toEqual(TAGS)
  })

  it('読み仮名とローマ字でも照らす（FR-418）', () => {
    const tags = [...TAGS, { id: 4, name: '座り', reading: 'すわり' }]
    expect(tagsByName(tags, 'suwari', new Set()).map((t) => t.id)).toEqual([4])
  })

  it('keep のタグ（選んでいるタグと除いているタグ）は、名前に含まなくても返す', () => {
    expect(tagsByName(TAGS, 'pose', new Set([3])).map((t) => t.id)).toEqual([1, 3])
  })

  it('2,000 個のタグから、入力した文字を含むものだけを返す', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `タグ${i}` }))
    expect(tagsByName(many, '199', new Set()).map((t) => t.name)).toEqual([
      'タグ199',
      'タグ1199',
      ...Array.from({ length: 10 }, (_, i) => `タグ199${i}`),
    ])
  })
})

describe('rememberTag', () => {
  it('使ったタグを先頭に置き、前にあった同じタグは消す', () => {
    expect(rememberTag([], 1)).toEqual([1])
    expect(rememberTag([2, 1, 3], 1)).toEqual([1, 2, 3])
  })
})

describe('recentCandidates', () => {
  it('使った新しい順に、選んだ画像のすべてに付いているタグと消えたタグを除いて limit まで返す', () => {
    expect(recentCandidates(TAGS, [3, 9, 1, 2], new Set([1])).map((t) => t.id)).toEqual([3, 2])
    expect(recentCandidates(TAGS, [3, 1, 2], new Set(), 2).map((t) => t.id)).toEqual([3, 1])
  })
})

describe('recentLimit', () => {
  it('5、10、15 はそのまま、それ以外は 5 にする', () => {
    expect([5, 10, 15, 0, 7, 100].map(recentLimit)).toEqual([5, 10, 15, 5, 5, 5])
  })
})

describe('categoryCandidates の読み仮名', () => {
  it('道筋の読み仮名でも照らすので、読み仮名で子も出る（FR-418）', () => {
    const categories = [
      { id: 1, name: '姿勢', parent_id: null, collapsed: false, reading: 'しせい' },
      { id: 2, name: '座り', parent_id: 1, collapsed: false, reading: 'すわり' },
    ]
    expect(categoryCandidates(categories, 'suwari').map((c) => c.id)).toEqual([2])
    expect(categoryCandidates(categories, 'shisei').map((c) => c.id)).toEqual([1, 2])
  })
})

describe('categoryCandidates', () => {
  const categories = [
    { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
    { id: 2, name: '座り', parent_id: 1, collapsed: false },
    { id: 4, name: '服飾', parent_id: null, collapsed: false },
  ]

  it('未分類を外すと、カテゴリだけを返す（カテゴリの統合の統合先）', () => {
    expect(categoryCandidates(categories, '', false).map((c) => c.id)).toEqual([1, 2, 4])
  })

  it('空の入力では、未分類とツリーの順のすべてのカテゴリを返す', () => {
    expect(categoryCandidates(categories, '')).toEqual([
      { id: null, label: '未分類' },
      { id: 1, label: 'ポーズ' },
      { id: 2, label: 'ポーズ / 座り' },
      { id: 4, label: '服飾' },
    ])
  })

  it('入力した文字を道筋に含むものを返すので、親の名前で子も出る', () => {
    expect(categoryCandidates(categories, 'ぽーず').map((c) => c.id)).toEqual([1, 2])
    expect(categoryCandidates(categories, 'ポーズ').map((c) => c.id)).toEqual([1, 2])
    expect(categoryCandidates(categories, '未分').map((c) => c.id)).toEqual([null])
  })
})

describe('categoryOptions', () => {
  it('ツリーの順に、親からの道筋を名前にする', () => {
    const options = categoryOptions([
      { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
      { id: 4, name: '服飾', parent_id: null, collapsed: false },
      { id: 2, name: '座り', parent_id: 1, collapsed: false },
      { id: 3, name: '椅子', parent_id: 2, collapsed: false },
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
    { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
    { id: 2, name: '座り', parent_id: 1, collapsed: false },
    { id: 3, name: '服飾', parent_id: null, collapsed: false },
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

  test('カテゴリとタグの読み仮名をローマ字・かなで照らす（FR-418）', () => {
    const c = [{ id: 2, name: '座り', parent_id: null, collapsed: false, reading: 'すわり' }]
    const t = [
      { id: 10, name: '座り', reading: 'すわり' },
      { id: 11, name: 'スワリ' },
    ]
    for (const typed of ['suwari', 'すわり', 'スワリ'])
      expect(filterCandidates(c, t, typed, NO_FILTER)).toEqual([
        { kind: 'category', id: 2, label: '座り' },
        { kind: 'tag', id: 10, label: '座り' },
        { kind: 'tag', id: 11, label: 'スワリ' },
      ])
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
    expect([move('ArrowDown', -1), move('ArrowDown', 2), move('ArrowUp', -1), move('ArrowUp', 0)]).toEqual([
      0, -1, 2, -1,
    ])
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
