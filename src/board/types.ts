// src-tauri/src/board.rs の Summary（ボードの一覧の1行）
export type BoardSummary = { id: number; name: string; placement_count: number; updated_at: number }

// src-tauri/src/main.rs の Boards（list_boards の返り値）。session はボードの操作に添えるライブラリのトークン
export type Boards = { session: number; boards: BoardSummary[]; last_board_id: number | null }

// src-tauri/src/board.rs の Viewport。x と y はキャンバスの中央に見えるボード上の点、scale は表示の倍率
export type Viewport = { x: number; y: number; scale: number }

// src-tauri/src/board.rs の Geometry。width と height は倍率をかける前の枠の寸法、x と y は枠の左上
export type Geometry = {
  width: number
  height: number
  x: number
  y: number
  scale: number
  rotation: number
  flipped: boolean
  grayscale: boolean
  crop: { x: number; y: number; width: number; height: number } | null
  stack_order: number
}

// src-tauri/src/board.rs の Source。画像の状態は Rust が DB から返す
export type Source = {
  id: number
  image_id: number | null
  file_name: string
  width: number
  height: number
  status: 'available' | 'trashed' | 'missing' | 'deleted'
}

export type Item = { id: number; source: Source; geometry: Geometry }

export type Edit = { library_session: number; board_id: number; token: number }

// src-tauri/src/board.rs の Snapshot（save_board に送る配置と表示）。新しい配置は id を null にする
export type Snapshot = { viewport: Viewport; items: { id: number | null; source_id: number; geometry: Geometry }[] }

export type Board = {
  id: number
  name: string
  viewport: Viewport
  updated_at: number
  revision: number
  items: Item[]
}

// src-tauri/src/board.rs の EditingBoard（open_board、create_board、save_board の返り値）
export type EditingBoard = { edit: Edit; board: Board }

// src-tauri/src/board.rs の Target（add_to_board の追加先）
export type Target = { board: number } | { new: string }

// src-tauri/src/board.rs の Added（take_board_reveal の返り値）。追加先と、追加した配置
export type Added = { board_id: number; placements: number[] }
