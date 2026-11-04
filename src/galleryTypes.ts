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
  source: { image_url: string; page_url: string | null } | null
}

// src-tauri/src/tag.rs の Counted（image_tags コマンドの返り値）。count は選んだ画像のうちそのタグが付いている枚数
export type CountedTag = Tag & { count: number }

// src-tauri/src/category.rs の Assigned（set_category コマンドの返り値）
export type Assigned = {
  moved: { id: number; file_name: string }[]
  failed: { id: number; message: string }[]
}

// src-tauri/src/category.rs の Deleted（delete_category コマンドの返り値）。error が null ならカテゴリは子カテゴリごと消えた
export type Deleted = Assigned & { error: string | null }
