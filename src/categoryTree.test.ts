import { expect, test } from 'vitest'
import { subtree } from './categoryTree'

test('カテゴリ自身と子孫を返し、ほかの枝は含めない', () => {
  // 孫（3）が親（2）より前に並んでいても拾う
  const categories = [
    { id: 3, name: '椅子', parent_id: 2, collapsed: false },
    { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
    { id: 2, name: '座り', parent_id: 1, collapsed: false },
    { id: 4, name: '服飾', parent_id: null, collapsed: false },
    { id: 5, name: '制服', parent_id: 4, collapsed: false },
  ]
  expect([...subtree(categories, 1)].sort()).toEqual([1, 2, 3])
  expect([...subtree(categories, 3)]).toEqual([3])
})
