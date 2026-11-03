import { mockIPC } from '@tauri-apps/api/mocks'

type Handler = (args: Record<string, unknown> | undefined) => unknown

// Tauri のコマンドを足したら、同じ名前でここに応答を足す
const handlers: Record<string, Handler> = {}

export function installMockIPC() {
  mockIPC((cmd, args) => {
    const handler = handlers[cmd]
    if (!handler) throw new Error(`モックが未定義のコマンド: ${cmd}`)
    return handler(args as Record<string, unknown> | undefined)
  })
}
