import { describe, expect, it } from 'vitest'
import { imageMenu, parentMoves } from './contextMenu'

const ALL_ON = { count: 1, board: true, similarity: true }
const CATEGORY = ['category', 'parent'] as const

describe('imageMenu', () => {
  it('一覧の1枚では、詳細パネルの操作をすべて出し、まとまりの間に区切りを入れる', () => {
    expect(imageMenu('gallery', ALL_ON)).toEqual([
      'similar',
      'board',
      'rule',
      ...CATEGORY,
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
  })

  it('一覧の複数枚では、1枚にしか効かない Finder で表示を出さない', () => {
    expect(imageMenu('gallery', { ...ALL_ON, count: 3 })).toEqual([
      'similar',
      'board',
      'rule',
      ...CATEGORY,
      'rule',
      'trash',
    ])
  })

  it('アイデアボードと類似画像検索が OFF なら、その項目と余る区切りを出さない', () => {
    expect(imageMenu('gallery', { count: 1, board: false, similarity: false })).toEqual([
      ...CATEGORY,
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
    expect(imageMenu('gallery', { count: 2, board: false, similarity: true })).toEqual([
      'similar',
      'rule',
      ...CATEGORY,
      'rule',
      'trash',
    ])
  })

  it('最後に画像を追加したボードが残っていれば、「ボードに追加…」の前に出す。アイデアボードが OFF なら出さない', () => {
    expect(imageMenu('gallery', { ...ALL_ON, lastBoard: true })).toEqual([
      'similar',
      'lastBoard',
      'board',
      'rule',
      ...CATEGORY,
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
    expect(imageMenu('gallery', { ...ALL_ON, board: false, lastBoard: true })).toEqual([
      'similar',
      'rule',
      ...CATEGORY,
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
  })

  it('類似画像検索の結果のモードで2枚以上を選んでいれば、「ゴミ箱へ移す」の前に「1枚にまとめる…」を出す', () => {
    expect(imageMenu('gallery', { ...ALL_ON, count: 2, merge: true })).toEqual([
      'similar',
      'board',
      'rule',
      ...CATEGORY,
      'rule',
      'merge',
      'trash',
    ])
    expect(imageMenu('gallery', { ...ALL_ON, count: 1, merge: true })).not.toContain('merge')
    expect(imageMenu('gallery', { ...ALL_ON, count: 2 })).not.toContain('merge')
  })

  it('ゴミ箱と見つからない画像では、その画面の操作だけを出し、カテゴリを変える操作は出さない', () => {
    expect(imageMenu('trash', ALL_ON)).toEqual(['restore', 'purge'])
    expect(imageMenu('missing', ALL_ON)).toEqual(['forget'])
  })
})

describe('parentMoves', () => {
  // A（一番上）/ B / C、と D（一番上）
  const categories = [
    { id: 1, name: 'A', parent_id: null, collapsed: false },
    { id: 2, name: 'B', parent_id: 1, collapsed: false },
    { id: 3, name: 'C', parent_id: 2, collapsed: false },
    { id: 4, name: 'D', parent_id: null, collapsed: false },
  ]
  const img = (id: number, category_id: number | null) => ({ id, category_id })

  it('揃ったカテゴリの画像は、まとめてその親へ移す', () => {
    expect(parentMoves([img(10, 3), img(11, 3)], categories)).toEqual([{ category: 2, ids: [10, 11] }])
  })

  it('揃っていない画像は、それぞれの1つ上へ移す', () => {
    expect(parentMoves([img(10, 3), img(11, 2), img(12, 3)], categories)).toEqual([
      { category: 2, ids: [10, 12] },
      { category: 1, ids: [11] },
    ])
  })

  it('未分類か一番上の階層のカテゴリの画像を1枚でも含むと、移せない（null）', () => {
    expect(parentMoves([img(10, 3), img(11, null)], categories)).toBeNull()
    expect(parentMoves([img(10, 3), img(11, 4)], categories)).toBeNull()
    expect(parentMoves([img(10, 1)], categories)).toBeNull()
  })

  it('画像を選んでいなければ移せない', () => {
    expect(parentMoves([], categories)).toBeNull()
  })
})
