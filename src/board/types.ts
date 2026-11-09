// src-tauri/src/board.rs の Summary（ボードの一覧の1行）
export type BoardSummary = { id: number; name: string; placement_count: number; updated_at: number }

// src-tauri/src/main.rs の Boards（list_boards の返り値）。session はボードの操作に添えるライブラリのトークン
export type Boards = { session: number; boards: BoardSummary[]; last_board_id: number | null }

// src-tauri/src/board.rs の EditingBoard（open_board と create_board の返り値）。配置の中身は後のタスクで使う
export type EditingBoard = {
  edit: { library_session: number; board_id: number; token: number }
  board: { id: number; name: string; revision: number; items: { id: number }[] }
}
