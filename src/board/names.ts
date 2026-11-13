// src-tauri/src/board.rs の name と同じく、前後の空白を除き NFC と大文字・小文字をそろえて同名を判定する
export const nameKey = (name: string) => name.trim().normalize('NFC').toLowerCase()

const BASE = '新しいボード'

// 新規作成の名前の初期値（FR-701）。使用済みなら「新しいボード 2」のように番号を付ける
export function defaultName(used: string[]) {
  const keys = new Set(used.map(nameKey))
  for (let n = 1; ; n++) {
    const name = n === 1 ? BASE : `${BASE} ${n}`
    if (!keys.has(nameKey(name))) return name
  }
}
