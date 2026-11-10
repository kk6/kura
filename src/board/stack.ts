import type { Item } from './types'

// 重なり順の操作（FR-702）。front は最前面へ、forward は1つ前へ、backward は1つ後ろへ、back は最背面へ
export type Restack = 'front' | 'forward' | 'backward' | 'back'

// 選んだ配置の重なり順を変えた配置を返す。選んだ配置同士の順序は保つ。順序が変わらなければ null。
// 変えた後は奥から 0、1、2… と振り直す。同じ値が残ると、Rust と同じく ID の順で前後が決まってしまうため
export function restack(items: Item[], selected: Set<number>, to: Restack): Item[] | null {
  const from = [...items].sort((a, b) => a.geometry.stack_order - b.geometry.stack_order || a.id - b.id)
  const picked = (i: Item) => selected.has(i.id)
  let next = [...from]
  if (to === 'front') next = [...from.filter((i) => !picked(i)), ...from.filter(picked)]
  else if (to === 'back') next = [...from.filter(picked), ...from.filter((i) => !picked(i))]
  else {
    // 進む側の端から見る。先に進んだ配置の後ろが空くので、選んだ配置同士は入れ替わらない
    const step = to === 'forward' ? 1 : -1
    for (let n = step > 0 ? next.length - 2 : 1; n >= 0 && n < next.length; n -= step) {
      if (picked(next[n]) && !picked(next[n + step])) [next[n], next[n + step]] = [next[n + step], next[n]]
    }
  }
  if (next.every((i, n) => i === from[n])) return null
  const order = new Map(next.map((i, n) => [i.id, n]))
  return items.map((i) => {
    const stack_order = order.get(i.id)!
    return i.geometry.stack_order === stack_order ? i : { ...i, geometry: { ...i.geometry, stack_order } }
  })
}
