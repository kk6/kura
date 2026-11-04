// src-tauri/src/gallery.rs の Gallery（load_gallery コマンドの返り値）
export type Image = {
  id: number
  file_name: string
  hash: string
  width: number
  height: number
  color: string
  category_id: number | null
  rating: number
  imported_at: number
}

export type Category = { id: number; name: string; parent_id: number | null }

export type Tag = { id: number; name: string }

export type Gallery = { images: Image[]; categories: Category[]; tags: Tag[] }

// src-tauri/src/gallery.rs の Detail（image_detail コマンドの返り値）
export type Detail = {
  path: string
  file_size: number
  memo: string
  tags: Tag[]
  source: { image_url: string; page_url: string | null } | null
}
