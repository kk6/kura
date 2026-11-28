// 一覧の選択（FR-509）。一覧は表示範囲の近くしか描かないので、選択は画像の id で持つ
export type Selection = { ids: Set<number>; anchor: number | null }

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null }

// order は今の並び順の id。Shift の範囲はこの順で決める
export function select(
  s: Selection,
  order: readonly number[],
  id: number,
  mods: { shift: boolean; meta: boolean },
): Selection {
  if (mods.meta) {
    const ids = new Set(s.ids)
    if (!ids.delete(id)) ids.add(id)
    return { ids, anchor: id }
  }
  const from = s.anchor === null ? -1 : order.indexOf(s.anchor)
  if (mods.shift && from >= 0) {
    const to = order.indexOf(id)
    return { ids: new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)), anchor: s.anchor }
  }
  return { ids: new Set([id]), anchor: id }
}

// 範囲選択（FR-512）。base は押したときの選択、hit は囲んだ画像の id（並び順）。
// additive（⌘ か Shift）なら base に足す。起点は囲んだ画像の先頭にし、続く Shift＋クリックの範囲をそこから決める
export function enclose(base: Selection, hit: readonly number[], additive: boolean): Selection {
  if (!additive && !hit.length) return EMPTY_SELECTION
  return { ids: new Set([...(additive ? base.ids : []), ...hit]), anchor: hit[0] ?? base.anchor }
}

// alive にない画像を選択から外す。変わらなければ s をそのまま返す
export function keepOnly(s: Selection, alive: ReadonlySet<number>): Selection {
  const ids = new Set([...s.ids].filter((id) => alive.has(id)))
  if (ids.size === s.ids.size) return s
  return { ids, anchor: s.anchor !== null && ids.has(s.anchor) ? s.anchor : null }
}
