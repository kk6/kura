import { invoke } from '@tauri-apps/api/core'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { useEffect, useState } from 'react'
import Status from './Status'
import './LibrarySelect.css'

export type OpenCommand = 'create_library' | 'open_library'

type Props = {
  recent: string[]
  error?: string
  onOpen: (command: OpenCommand, path: string) => void
  // 最近使ったライブラリの一覧から外す。フォルダは変えない（FR-106）
  onForget: (path: string) => void
}

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export default function LibrarySelect({ recent, error, onOpen, onForget }: Props) {
  // フォルダが見つからないライブラリ。外付けドライブが外れているだけのこともあるので、自動では外さない
  const [missing, setMissing] = useState<string[]>([])
  useEffect(() => {
    let current = true
    invoke<string[]>('missing_recent_libraries').then((m) => current && setMissing(m))
    return () => {
      current = false
    }
  }, [recent])

  async function pick(command: OpenCommand) {
    const title = command === 'create_library' ? '空のフォルダを選ぶ' : 'ライブラリのフォルダを選ぶ'
    const path = await open({ directory: true, canCreateDirectories: true, title })
    if (!path) return
    // 利用者が選んだときだけ確かめる。最近使った一覧から開くたびには聞かない（NFR-13）
    const warning = await invoke<string | null>('location_warning', { path })
    if (warning) {
      const ok = await ask(`注意：${warning}\n続けますか？`, {
        title: 'Kura',
        kind: 'warning',
        okLabel: '続ける',
        cancelLabel: 'キャンセル',
      })
      if (!ok) return
    }
    onOpen(command, path)
  }

  return (
    <main className="select" aria-label="ライブラリ選択">
      <div className="select__panel">
        <h1 className="select__title">Kura</h1>

        {error && (
          <p className="select__error" role="alert">
            <Status kind="error">{error}</Status>
          </p>
        )}

        <div className="select__actions">
          <button type="button" className="button button--primary" onClick={() => pick('create_library')}>
            新しいライブラリを作る
          </button>
          <button type="button" className="button" onClick={() => pick('open_library')}>
            ライブラリを開く
          </button>
        </div>

        <h2 className="select__heading">最近使ったライブラリ</h2>
        {recent.length ? (
          <ul className="select__recent">
            {recent.map((path) => (
              <li key={path} className="select__row">
                <button type="button" className="select__item" onClick={() => onOpen('open_library', path)}>
                  <span className="select__name">{folderName(path)}</span>
                  <span className="select__path">{path}</span>
                  {missing.includes(path) && <span className="select__missing">見つかりません</span>}
                </button>
                {missing.includes(path) && (
                  <button
                    type="button"
                    className="button select__forget"
                    aria-label={`${folderName(path)}を一覧から外す`}
                    onClick={() => onForget(path)}
                  >
                    一覧から外す
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="select__empty">まだありません</p>
        )}
      </div>
    </main>
  )
}
