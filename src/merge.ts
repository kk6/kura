import type { Image } from './galleryTypes'

type Candidate = Pick<Image, 'id' | 'width' | 'height' | 'imported_at'> & { file_size: number }

// 1枚にまとめる（FR-610）ときに残す画像の初期値。画素数（幅×高さ）が一番大きい画像、同じならファイルサイズの大きい方、
// それも同じなら取り込み日時の古い方。Rust が引き継ぐ元URLを選ぶ順（src-tauri/src/merge.rs）と同じ
export function defaultKeep(images: Candidate[]): number {
  const order = (a: Candidate, b: Candidate) =>
    b.width * b.height - a.width * a.height || b.file_size - a.file_size || a.imported_at - b.imported_at
  return [...images].sort(order)[0].id
}

// 残す画像に付けるタグの初期値。選んだ全部の画像のタグを合わせたもの
export const unionTags = (images: Pick<Image, 'tags'>[]) => [...new Set(images.flatMap((i) => i.tags))]
