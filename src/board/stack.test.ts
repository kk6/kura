import { expect, test } from 'vitest'
import { restack, type Restack } from './stack'
import type { Item } from './types'

const item = (id: number, stack_order: number) => ({ id, geometry: { stack_order } }) as Item

// 奥から手前への配置 ID の並び
const order = (items: Item[]) =>
  [...items].sort((a, b) => a.geometry.stack_order - b.geometry.stack_order || a.id - b.id).map((i) => i.id)

const moved = (items: Item[], selected: number[], to: Restack) => {
  const next = restack(items, new Set(selected), to)
  return next && order(next)
}

// 奥から 1、2、3、4、5
const five = [item(1, 0), item(2, 1), item(3, 2), item(4, 3), item(5, 4)]

test('最前面へ・最背面へは、選んだ配置同士の順序を保って端へ送る', () => {
  expect(moved(five, [2, 4], 'front')).toEqual([1, 3, 5, 2, 4])
  expect(moved(five, [2, 4], 'back')).toEqual([2, 4, 1, 3, 5])
})

test('1つ前へ・1つ後ろへは、選んでいない配置を1つだけ越える', () => {
  expect(moved(five, [2], 'forward')).toEqual([1, 3, 2, 4, 5])
  expect(moved(five, [2], 'backward')).toEqual([2, 1, 3, 4, 5])
  expect(moved(five, [2, 4], 'forward')).toEqual([1, 3, 2, 5, 4])
  expect(moved(five, [2, 4], 'backward')).toEqual([2, 1, 4, 3, 5])
})

test('隣り合う選んだ配置は、入れ替わらずにまとまって動く', () => {
  expect(moved(five, [2, 3], 'forward')).toEqual([1, 4, 2, 3, 5])
  expect(moved(five, [3, 4], 'backward')).toEqual([1, 3, 4, 2, 5])
  // 端に着いた配置は止まり、後ろの配置だけが進む
  expect(moved(five, [3, 5], 'forward')).toEqual([1, 2, 4, 3, 5])
})

test('順序が変わらなければ null を返す', () => {
  expect(moved(five, [4, 5], 'front')).toBeNull()
  expect(moved(five, [4, 5], 'forward')).toBeNull()
  expect(moved(five, [1], 'back')).toBeNull()
  expect(moved(five, [1], 'backward')).toBeNull()
  expect(moved(five, [], 'front')).toBeNull()
  expect(moved(five, [1, 2, 3, 4, 5], 'front')).toBeNull()
})

test('重なり順が同じ値の配置は ID の順に並んでいるものとして扱い、配列の順番は変えない', () => {
  const tied = [item(3, 0), item(1, 0), item(2, 0)]
  const next = restack(tied, new Set([1]), 'forward')!
  expect(order(next)).toEqual([2, 1, 3])
  expect(next.map((i) => i.id)).toEqual([3, 1, 2])
})

test('重なり順の変わらない配置は同じオブジェクトのまま返す', () => {
  const next = restack(five, new Set([4]), 'front')!
  expect(next[0]).toBe(five[0])
  expect(next[3]).not.toBe(five[3])
})
