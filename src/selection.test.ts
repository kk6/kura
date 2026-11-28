import { describe, expect, test } from 'vitest'
import { enclose, EMPTY_SELECTION, keepOnly, select } from './selection'

const order = [10, 20, 30, 40, 50]
const plain = { shift: false, meta: false }
const ids = (s: { ids: Set<number> }) => [...s.ids].sort((a, b) => a - b)

describe('select', () => {
  test('修飾キーなしで選ぶと、その画像だけを選ぶ', () => {
    const s = select(select(EMPTY_SELECTION, order, 20, plain), order, 40, plain)
    expect(ids(s)).toEqual([40])
  })

  test('Command で選ぶと、選択に足し、選択中の画像なら外す', () => {
    const meta = { shift: false, meta: true }
    let s = select(EMPTY_SELECTION, order, 20, plain)
    s = select(s, order, 40, meta)
    expect(ids(s)).toEqual([20, 40])
    s = select(s, order, 20, meta)
    expect(ids(s)).toEqual([40])
  })

  test('Shift で選ぶと、最後に選んだ画像から並び順で範囲を選ぶ', () => {
    const shift = { shift: true, meta: false }
    let s = select(EMPTY_SELECTION, order, 40, plain)
    s = select(s, order, 20, shift)
    expect(ids(s)).toEqual([20, 30, 40])
    // 起点は変わらないので、続けて Shift で選ぶと範囲を選び直す
    s = select(s, order, 50, shift)
    expect(ids(s)).toEqual([40, 50])
  })

  test('起点がないか一覧にないときの Shift は、その画像だけを選ぶ', () => {
    const shift = { shift: true, meta: false }
    expect(ids(select(EMPTY_SELECTION, order, 30, shift))).toEqual([30])
    const gone = select(EMPTY_SELECTION, [99], 99, plain)
    expect(ids(select(gone, order, 30, shift))).toEqual([30])
  })
})

describe('keepOnly', () => {
  test('残る画像だけを選択に残し、起点が消えたら起点をなくす', () => {
    const s = { ids: new Set([10, 20, 30]), anchor: 20 }
    expect(keepOnly(s, new Set([10, 30]))).toEqual({ ids: new Set([10, 30]), anchor: null })
    expect(keepOnly(s, new Set([20, 30]))).toEqual({ ids: new Set([20, 30]), anchor: 20 })
  })

  test('選択が変わらなければ同じ値を返し、再描画を起こさない', () => {
    const s = { ids: new Set([10, 20]), anchor: 10 }
    expect(keepOnly(s, new Set([10, 20, 30]))).toBe(s)
  })
})

describe('enclose', () => {
  const base = { ids: new Set([10, 50]), anchor: 50 }

  test('修飾キーなしでは、囲んだ画像だけを選び、並びの先頭を起点にする', () => {
    const s = enclose(base, [20, 30], false)
    expect(ids(s)).toEqual([20, 30])
    expect(s.anchor).toBe(20)
  })

  test('⌘ か Shift を押していれば、押したときの選択に足す', () => {
    expect(ids(enclose(base, [20, 30], true))).toEqual([10, 20, 30, 50])
  })

  test('何も囲んでいなければ、足すときは押したときの選択のまま、足さないときは何も選ばない', () => {
    expect(enclose(base, [], true)).toEqual(base)
    expect(enclose(base, [], false)).toEqual(EMPTY_SELECTION)
  })
})
