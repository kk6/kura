import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { useEffect, useRef, useState } from 'react'
import type { Settings } from './galleryTypes'
import Status from './Status'
import './SkipDialog.css'

// 設定ダイアログ（NFR-07）。サムネイルの大きさは一覧のスライダーの値を覚えるので、ここには置かない
export default function SettingsDialog({
  root,
  settings,
  onSettings,
  onClose,
}: {
  root: string
  settings: Settings
  onSettings: (next: Partial<Settings>) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [backup, setBackup] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  useEffect(() => ref.current?.showModal(), [])

  async function exportDb() {
    const name = root.split('/').pop()
    const date = new Date().toLocaleDateString('sv') // YYYY-MM-DD
    const path = await save({ defaultPath: `${name}-${date}.db`, filters: [{ name: 'SQLite', extensions: ['db'] }] })
    if (!path) return
    try {
      await invoke('backup_library', { path })
      setBackup({ kind: 'success', message: `${path} に書き出しました` })
    } catch (e) {
      setBackup({ kind: 'error', message: String(e) })
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="settings-title" onClose={onClose}>
      <h2 id="settings-title" className="dialog__title">
        設定
      </h2>
      <label className="dialog__check">
        <input
          type="checkbox"
          checked={settings.confirm_category_move}
          onChange={(e) => onSettings({ confirm_category_move: e.target.checked })}
        />
        サイドバーでカテゴリを移すときに確認する
      </label>
      <h3 className="dialog__section">アイデアボード</h3>
      <label className="dialog__check">
        <input
          type="checkbox"
          checked={settings.board_enabled}
          onChange={(e) => onSettings({ board_enabled: e.target.checked })}
        />
        アイデアボードを使う
      </label>
      <p>オフにするとボタンとメニューが消え、開いているボードは閉じます。作ったボードは消えません。</p>
      <h3 className="dialog__section">バックアップ</h3>
      <p>ライブラリの管理情報（カテゴリ、タグ、メモなど）を1つのファイルに書き出します。画像ファイルは含みません。</p>
      <div>
        <button type="button" className="button" onClick={exportDb}>
          管理情報を書き出す…
        </button>
      </div>
      {backup && <Status kind={backup.kind}>{backup.message}</Status>}
      <form method="dialog" className="dialog__actions">
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
