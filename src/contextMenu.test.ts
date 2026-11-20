import { describe, expect, it } from 'vitest'
import { imageMenu } from './contextMenu'

const ALL_ON = { count: 1, board: true, similarity: true }

describe('imageMenu', () => {
  it('一覧の1枚では、詳細パネルの操作をすべて出し、まとまりの間に区切りを入れる', () => {
    expect(imageMenu('gallery', ALL_ON)).toEqual(['similar', 'board', 'rule', 'reveal', 'rule', 'trash'])
  })

  it('一覧の複数枚では、1枚にしか効かない Finder で表示を出さない', () => {
    expect(imageMenu('gallery', { ...ALL_ON, count: 3 })).toEqual(['similar', 'board', 'rule', 'trash'])
  })

  it('アイデアボードと類似画像検索が OFF なら、その項目と余る区切りを出さない', () => {
    expect(imageMenu('gallery', { count: 1, board: false, similarity: false })).toEqual(['reveal', 'rule', 'trash'])
    expect(imageMenu('gallery', { count: 2, board: false, similarity: true })).toEqual(['similar', 'rule', 'trash'])
  })

  it('最後に画像を追加したボードが残っていれば、「ボードに追加…」の前に出す。アイデアボードが OFF なら出さない', () => {
    expect(imageMenu('gallery', { ...ALL_ON, lastBoard: true })).toEqual([
      'similar',
      'lastBoard',
      'board',
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
    expect(imageMenu('gallery', { ...ALL_ON, board: false, lastBoard: true })).toEqual([
      'similar',
      'rule',
      'reveal',
      'rule',
      'trash',
    ])
  })

  it('ゴミ箱と見つからない画像では、その画面の操作だけを出す', () => {
    expect(imageMenu('trash', ALL_ON)).toEqual(['restore', 'purge'])
    expect(imageMenu('missing', ALL_ON)).toEqual(['forget'])
  })
})
