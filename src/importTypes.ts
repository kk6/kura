// src-tauri/src/import.rs の Report と Skipped（import_paths コマンドの返り値）
export type Skipped = { path: string } & (
  | { kind: 'duplicate'; existing: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
)

export type Report = { added: number; skipped: Skipped[] }

export type ImportProgress = { done: number; total: number }
