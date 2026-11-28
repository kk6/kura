import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import Gallery from './Gallery'
import type { Settings } from './galleryTypes'
import LibrarySelect, { type OpenCommand } from './LibrarySelect'

// opened：開いた時刻。同じライブラリを開き直したときも、画面を作り直すために変える
type Screen =
  { kind: 'loading' } | { kind: 'select'; error?: string } | { kind: 'gallery'; path: string; opened: number }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [recent, setRecent] = useState<string[]>([])
  // アプリ全体の設定。読み終わるまで画面を出さない（サムネイルの大きさが途中で変わらないように）
  const [settings, setSettings] = useState<Settings | null>(null)

  // 保存できなければ元の値に戻す。アイデアボードの OFF に失敗したら ON のままにするため（FR-711）
  async function saveSettings(next: Settings) {
    const before = settings
    setSettings(next)
    try {
      await invoke('save_settings', { settings: next })
    } catch (e) {
      setSettings(before)
      throw e
    }
  }

  async function openLibrary(command: OpenCommand, path: string) {
    try {
      setScreen({ kind: 'gallery', path: await invoke<string>(command, { path }), opened: Date.now() })
    } catch (e) {
      setScreen({ kind: 'select', error: String(e) })
    }
    setRecent(await invoke<string[]>('list_recent_libraries'))
  }

  // 履歴から外すだけで、フォルダは変えない（FR-106）。保存できなければ選択画面にエラーを出す
  async function forgetLibrary(path: string) {
    try {
      setRecent(await invoke<string[]>('forget_recent_library', { path }))
    } catch (e) {
      setScreen({ kind: 'select', error: String(e) })
    }
  }

  // メニューバーの「隠すモード」（FR-513）。Rust が保存してから今の値を知らせる
  useEffect(() => {
    const off = listen<boolean>('hide-mode', (e) => setSettings((s) => s && { ...s, hide_mode: e.payload }))
    return () => void off.then((f) => f())
  }, [])

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
      // key：別のライブラリへ切り替えたか、管理情報を戻して開き直したら、一覧と選択を作り直す
      <Gallery
        key={`${screen.path}#${screen.opened}`}
        root={screen.path}
        recent={recent}
        settings={settings}
        onSettings={saveSettings}
        onSwitch={(path) => (path ? openLibrary('open_library', path) : setScreen({ kind: 'select' }))}
        onReopen={() => setScreen({ ...screen, opened: Date.now() })}
      />
    )
  return <LibrarySelect recent={recent} error={screen.error} onOpen={openLibrary} onForget={forgetLibrary} />
}
