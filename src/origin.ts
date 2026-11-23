// 元が同じ画像の組（FR-611）の結果のモードに出す組

/** 組の id を手元の一覧の画像に置き換える。ゴミ箱へ移した画像などは外し、2枚に満たない組は出さない。
 *  matches があれば、条件に合う画像を1枚でも含む組だけを、組の全部の画像ごと残す。まとめるときに組の全部を見るため */
export function showGroups<T extends { id: number }>(
  groups: number[][],
  byId: Map<number, T>,
  matches: Set<number> | null,
): T[][] {
  return groups
    .map((g) => g.flatMap((id) => byId.get(id) ?? []))
    .filter((g) => g.length >= 2 && (!matches || g.some((i) => matches.has(i.id))))
}
