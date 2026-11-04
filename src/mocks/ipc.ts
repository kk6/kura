import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { Report } from '../importTypes'

type Handler = (args: Record<string, unknown> | undefined) => unknown

// 先頭は外付けドライブが外れたライブラリ。起動時に開けず、選択画面に「見つかりません」が出る
const RECENT = ['/Volumes/外付けSSD/参考資料', '/Users/me/Pictures/Kura ライブラリ']

const openLibrary: Handler = (args) => {
  const path = String(args?.path)
  if (path.startsWith('/Volumes/')) throw `ライブラリが見つかりません（${path}）`
  return path
}

const REPORT: Report = {
  added: 477,
  skipped: [
    { path: '/Users/me/Downloads/資料/ポーズ/座り/ref_00012.jpg', kind: 'duplicate', existing: 3 },
    { path: '/Users/me/Downloads/資料/_重複/ref_00012 のコピー.jpg', kind: 'duplicate', existing: 3 },
    { path: '/Users/me/Downloads/資料/服飾/scan.heic', kind: 'unsupported' },
    {
      path: '/Users/me/Downloads/資料/背景/壊れた.png',
      kind: 'error',
      message: '画像を読めません（Format error decoding Png）',
    },
  ],
}

// 進み具合を途中で止めて、e2e で取り込み中の表示を確かめられるようにする
const importPaths: Handler = async () => {
  const total = REPORT.added + REPORT.skipped.length
  await emit('import-progress', { done: 0, total })
  await emit('import-progress', { done: 240, total })
  await new Promise((r) => setTimeout(r, 800))
  await emit('import-progress', { done: total, total })
  return REPORT
}

// Tauri のコマンドを足したら、同じ名前でここに応答を足す
const handlers: Record<string, Handler> = {
  list_recent_libraries: () => RECENT,
  location_warning: () => null,
  open_library: openLibrary,
  create_library: (args) => args?.path,
  import_paths: importPaths,
  'plugin:dialog|open': (args) =>
    (args?.options as { multiple?: boolean })?.multiple
      ? ['/Users/me/Downloads/資料']
      : '/Users/me/Pictures/新しいライブラリ',
}

export function installMockIPC() {
  // ドラッグ＆ドロップは getCurrentWebview() で受けるので、ウィンドウの情報も用意する
  mockWindows('main')
  // listen と emit を IPC なしで動かす。e2e ではドロップを tauri://drag-drop の emit で起こす
  mockIPC(
    (cmd, args) => {
      const handler = handlers[cmd]
      if (!handler) throw new Error(`モックが未定義のコマンド: ${cmd}`)
      return handler(args as Record<string, unknown> | undefined)
    },
    { shouldMockEvents: true },
  )
}
