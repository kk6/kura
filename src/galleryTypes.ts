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
  memo: string
  // 付いているタグの id
  tags: number[]
}

// collapsed：サイドバーで閉じている（ライブラリの DB に残る）
export type Category = { id: number; name: string; parent_id: number | null; collapsed: boolean }

export type Tag = { id: number; name: string }

export type Gallery = { images: Image[]; categories: Category[]; tags: Tag[] }

// src-tauri/src/gallery.rs の Detail（image_detail コマンドの返り値）
export type Detail = {
  path: string
  file_size: number
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

// src-tauri/src/trash.rs の Done（trash_images と empty_trash コマンドの返り値）
export type Done = { done: number[]; failed: { id: number; message: string }[] }

// src-tauri/src/trash.rs の Restored（restore_images コマンドの返り値）。uncategorized は元のカテゴリがなく未分類へ戻した画像
export type Restored = Assigned & { uncategorized: number[] }

// src-tauri/src/settings.rs の Settings（アプリ全体の設定。load_settings と save_settings）
export type Settings = {
  confirm_category_move: boolean
  thumb_width: number
  tags_collapsed: boolean
  // アイデアボードを使う（FR-711）
  board_enabled: boolean
}
