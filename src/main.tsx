import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { serveFlush } from './flush'
import { serveEditMenu } from './editMenu'

if (import.meta.env.MODE === 'mock') {
  const { installMockIPC } = await import('./mocks/ipc.ts')
  installMockIPC()
}

// アイデアボードの専用ウィンドウ、ヘルプ（NFR-14）とギャラリーは同じ index.html を開く。
// どれも開くときに読み込み、ボードを使わない起動ではボードの画面のコードを読まない（FR-711）。
// リリース用のビルドは最上位の await を使えないので then でつなぐ
const label = getCurrentWindow().label
const root =
  label === 'board'
    ? import('./board/BoardApp.tsx')
    : label === 'help'
      ? import('./help/HelpApp.tsx')
      : import('./App.tsx')
root.then(({ default: Root }) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
  // 閉じる・終了の前の保存の依頼を受ける（FR-704、FR-411）。ヘルプには保存するものがない
  if (label !== 'help') serveFlush().catch((e) => console.error(e))
  serveEditMenu().catch((e) => console.error(e))
})
