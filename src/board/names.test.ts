import { expect, test } from 'vitest'
import { defaultName } from './names'

test('ボードがなければ「新しいボード」', () => {
  expect(defaultName([])).toBe('新しいボード')
})

test('使用済みの名前には番号を付け、空いている一番小さい番号にする', () => {
  expect(defaultName(['新しいボード'])).toBe('新しいボード 2')
  expect(defaultName(['新しいボード', '新しいボード 2', '新しいボード 4'])).toBe('新しいボード 3')
})

test('前後の空白・NFC・大文字小文字の違いだけの名前も使用済みとみなす', () => {
  // 濁点を分けて書いた（NFD の）「ボ」
  expect(defaultName([' 新しいボード '])).toBe('新しいボード 2')
})
