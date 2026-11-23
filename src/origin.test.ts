import { describe, expect, it } from 'vitest'
import { showGroups } from './origin'

const byId = new Map([1, 2, 3, 4, 5].map((id) => [id, { id }]))

describe('showGroups', () => {
  it('組の画像を手元の一覧の画像に置き換え、2枚に満たなくなった組は外す', () => {
    // 6 はゴミ箱へ移したなどで手元の一覧にない。[5, 6] の組は1枚になる
    expect(
      showGroups(
        [
          [1, 2, 6],
          [3, 4],
          [5, 6],
        ],
        byId,
        null,
      ),
    ).toEqual([
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }, { id: 4 }],
    ])
  })

  it('絞り込みの条件に合う画像を1枚でも含む組は、合わない画像も含めて組ごと出す', () => {
    expect(
      showGroups(
        [
          [1, 2],
          [3, 4],
          [5, 1],
        ],
        byId,
        new Set([2, 5]),
      ),
    ).toEqual([
      [{ id: 1 }, { id: 2 }],
      [{ id: 5 }, { id: 1 }],
    ])
  })
})
