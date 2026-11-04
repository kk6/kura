import { describe, expect, it } from 'vitest'
import { candidates, categoryOptions } from './choices'

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
