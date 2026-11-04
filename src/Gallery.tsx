import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useRef, useState } from 'react'
import SkipDialog from './SkipDialog'
import Status from './Status'
import type { ImportProgress, Report } from './importTypes'
import './Gallery.css'

type Result = { kind: 'report'; report: Report } | { kind: 'error'; message: string }

export default function Gallery() {
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const busy = useRef(false)

  // shortcut: 取り込み中に選んだりドロップしたりしたものは無視する。続けて取り込みたい要望が出たら順番待ちにする
  async function start(paths: string[]) {
    if (busy.current || !paths.length) return
    busy.current = true
    setProgress({ done: 0, total: 0 })
    try {
      setResult({ kind: 'report', report: await invoke<Report>('import_paths', { paths, category: null }) })
    } catch (e) {
      setResult({ kind: 'error', message: String(e) })
    }
    busy.current = false
    setProgress(null)
  }
  const startRef = useRef(start)
  startRef.current = start

  useEffect(() => {
    const unlisten = [
      listen<ImportProgress>('import-progress', (e) => setProgress(e.payload)),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'drop') startRef.current(e.payload.paths)
      }),
    ]
    return () => unlisten.forEach((p) => p.then((f) => f()))
  }, [])

  async function pick(directory: boolean) {
    const title = directory ? '取り込むフォルダを選ぶ' : '取り込む画像を選ぶ'
    const paths = await open({ multiple: true, directory, title })
    if (paths) start(paths)
  }

  const skipped = result?.kind === 'report' ? result.report.skipped : []
  const errors = skipped.filter((s) => s.kind === 'error').length

  return (
    <div className="gallery">
      <header className="gallery__header">
        <span className="gallery__logo">Kura</span>
        <input className="gallery__search" type="search" placeholder="検索" aria-label="検索" />
        <button type="button" className="button" disabled={!!progress} onClick={() => pick(false)}>
          画像を取り込む
        </button>
        <button type="button" className="button" disabled={!!progress} onClick={() => pick(true)}>
          フォルダを取り込む
        </button>
      </header>

      <nav className="gallery__sidebar" aria-label="サイドバー">
        <ul className="sidebar__list">
          <li className="sidebar__item sidebar__item--selected" aria-current="true">
            すべての画像<span className="sidebar__count">0</span>
          </li>
          <li className="sidebar__item">
            未分類<span className="sidebar__count">0</span>
          </li>
        </ul>
        <h2 className="sidebar__heading">カテゴリ</h2>
        <h2 className="sidebar__heading">タグ</h2>
      </nav>

      <main className="gallery__list" aria-label="画像の一覧" />

      <aside className="gallery__detail" aria-label="詳細">
        <p className="detail__empty">画像を選ぶと、ここに詳細が出ます</p>
      </aside>

      <footer className="gallery__statusbar">
        <span>0枚</span>
        <span className="statusbar__import" role="status">
          {progress ? (
            <>
              取り込み中 {progress.done} / {progress.total}枚
              <span
                className="progress"
                role="progressbar"
                aria-label="取り込みの進み具合"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
              >
                <span
                  className="progress__done"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </span>
            </>
          ) : result?.kind === 'error' ? (
            <Status kind="error">{result.message}</Status>
          ) : result ? (
            <>
              <Status kind="success">取り込み {result.report.added}枚</Status>
              {skipped.length > errors && (
                <button type="button" className="statusbar__link" onClick={() => setShowSkipped(true)}>
                  <Status kind="warning">スキップ {skipped.length - errors}枚</Status>
                </button>
              )}
              {errors > 0 && (
                <button type="button" className="statusbar__link" onClick={() => setShowSkipped(true)}>
                  <Status kind="error">取り込めない {errors}件</Status>
                </button>
              )}
            </>
          ) : null}
        </span>
      </footer>

      {showSkipped && <SkipDialog skipped={skipped} onClose={() => setShowSkipped(false)} />}
    </div>
  )
}
