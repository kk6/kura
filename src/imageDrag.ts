// 一覧からボードのウィンドウへ運ぶ画像の ID（FR-713）。ギャラリーとボードは別のウィンドウなので、ドラッグのデータで渡す。
// ギャラリーがボードの画面のコードを読まないよう（FR-711）、src/board の外に置く
export const IMAGE_DRAG = 'application/x-kura-images'

// ほかのアプリが同じ種類で別のデータを落としても、画像として置かない
export function readDragged(raw: string): number[] | null {
  try {
    const ids: unknown = JSON.parse(raw)
    return Array.isArray(ids) && ids.length > 0 && ids.every(Number.isInteger) ? ids : null
  } catch {
    return null
  }
}
