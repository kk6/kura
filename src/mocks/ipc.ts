import { mockIPC } from '@tauri-apps/api/mocks'

type Handler = (args: Record<string, unknown> | undefined) => unknown

// 先頭は外付けドライブが外れたライブラリ。起動時に開けず、選択画面に「見つかりません」が出る
const RECENT = ['/Volumes/外付けSSD/参考資料', '/Users/me/Pictures/Kura ライブラリ']

const openLibrary: Handler = (args) => {
  const path = String(args?.path)
  if (path.startsWith('/Volumes/')) throw `ライブラリが見つかりません（${path}）`
  return path
}

// Tauri のコマンドを足したら、同じ名前でここに応答を足す
const handlers: Record<string, Handler> = {
  list_recent_libraries: () => RECENT,
  location_warning: () => null,
  open_library: openLibrary,
  create_library: (args) => args?.path,
  'plugin:dialog|open': () => '/Users/me/Pictures/新しいライブラリ',
}

export function installMockIPC() {
  mockIPC((cmd, args) => {
    const handler = handlers[cmd]
    if (!handler) throw new Error(`モックが未定義のコマンド: ${cmd}`)
    return handler(args as Record<string, unknown> | undefined)
  })
}
