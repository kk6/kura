import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import Gallery from './Gallery'
import type { Settings } from './galleryTypes'
import LibrarySelect, { type OpenCommand } from './LibrarySelect'

type Screen = { kind: 'loading' } | { kind: 'select'; error?: string } | { kind: 'gallery'; path: string }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [recent, setRecent] = useState<string[]>([])
  // アプリ全体の設定。読み終わるまで画面を出さない（サムネイルの大きさが途中で変わらないように）
  const [settings, setSettings] = useState<Settings | null>(null)

  async function saveSettings(next: Settings) {
    setSettings(next)
    await invoke('save_settings', { settings: next })
  }

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
    invoke<Settings>('load_settings').then(setSettings)
    invoke<string[]>('list_recent_libraries').then((list) => {
      setRecent(list)
      if (list[0]) openLibrary('open_library', list[0])
      else setScreen({ kind: 'select' })
    })
  }, [])

  if (screen.kind === 'loading' || !settings) return null
  if (screen.kind === 'gallery')
    return (
      // key：別のライブラリへ切り替えたら、一覧と選択を作り直す
      <Gallery
        key={screen.path}
        root={screen.path}
        recent={recent}
        settings={settings}
        onSettings={saveSettings}
        onSwitch={(path) => (path ? openLibrary('open_library', path) : setScreen({ kind: 'select' }))}
      />
    )
  return <LibrarySelect recent={recent} error={screen.error} onOpen={openLibrary} />
}
