// src-tauri/src/import.rs の Report と Skipped（import_paths コマンドの返り値）
export type Skipped = { path: string } & (
  { kind: 'duplicate'; existing: number } | { kind: 'unsupported' } | { kind: 'error'; message: string }
)

// moved は、同じ画像が未分類にあったので取り込み先のカテゴリへ移した枚数（FR-204 の例外）
export type Report = { added: number; moved: number; skipped: Skipped[] }

export type ImportProgress = { done: number; total: number }

// src-tauri/src/sync.rs の Report（scan_library コマンドの返り値。差分検出 FR-104）
export type ScanReport = {
  added: number
  moved: number
  updated: number
  missing: number
  returned: number
  categories_added: number
  categories_removed: number
  skipped: Skipped[]
}
