import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import Gallery from './Gallery'
import LibrarySelect, { type OpenCommand } from './LibrarySelect'

type Screen = { kind: 'loading' } | { kind: 'select'; error?: string } | { kind: 'gallery'; path: string }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [recent, setRecent] = useState<string[]>([])

  async function openLibrary(command: OpenCommand, path: string) {
    try {
      setScreen({ kind: 'gallery', path: await invoke<string>(command, { path }) })
    } catch (e) {
      setScreen({ kind: 'select', error: String(e) })
    }
    setRecent(await invoke<string[]>('list_recent_libraries'))
  }

  // 起動時は前回のライブラリを開く。見つからなければ選択画面にその旨を出す（NFR-13）
  useEffect(() => {
    invoke<string[]>('list_recent_libraries').then((list) => {
      setRecent(list)
      if (list[0]) openLibrary('open_library', list[0])
      else setScreen({ kind: 'select' })
    })
  }, [])

  if (screen.kind === 'loading') return null
  if (screen.kind === 'gallery') return <Gallery />
  return <LibrarySelect recent={recent} error={screen.error} onOpen={openLibrary} />
}
