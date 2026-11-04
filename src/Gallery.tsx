import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import Detail from './Detail'
import Masonry from './Masonry'
import Sidebar from './Sidebar'
import SkipDialog from './SkipDialog'
import Status from './Status'
import type { Gallery as GalleryData } from './galleryTypes'
import type { ImportProgress, Report } from './importTypes'
import { EMPTY_SELECTION, select } from './selection'
import { SORTS, type SortKey, sortImages } from './sort'
import './Gallery.css'

type Result = { kind: 'report'; report: Report } | { kind: 'error'; message: string }

const EMPTY: GalleryData = { images: [], categories: [], tags: [] }

// サムネイルの列の幅の目安。上限はサムネイルの幅（320）
const THUMB_MIN = 100
const THUMB_MAX = 320

export default function Gallery({ root }: { root: string }) {
  const [data, setData] = useState(EMPTY)
  const [sort, setSort] = useState<SortKey>('imported')
  const [thumbWidth, setThumbWidth] = useState(200)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [selection, setSelection] = useState(EMPTY_SELECTION)
  const busy = useRef(false)

  async function reload() {
    try {
      setData(await invoke<GalleryData>('load_gallery'))
      setLoadError(null)
    } catch (e) {
      setLoadError(String(e))
    }
  }
  useEffect(() => void reload(), [])

  const images = useMemo(() => sortImages(data.images, sort), [data.images, sort])
  const order = useMemo(() => images.map((i) => i.id), [images])
  const only = selection.ids.size === 1 ? [...selection.ids][0] : null
  const selectedImage = useMemo(() => data.images.find((i) => i.id === only) ?? null, [data.images, only])

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
    reload()
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
        <select
          className="gallery__sort"
          aria-label="並べ替え"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          {Object.entries(SORTS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="gallery__size"
          type="range"
          aria-label="サムネイルの大きさ"
          min={THUMB_MIN}
          max={THUMB_MAX}
          step={10}
          value={thumbWidth}
          onChange={(e) => setThumbWidth(Number(e.target.value))}
        />
        <button type="button" className="button" disabled={!!progress} onClick={() => pick(false)}>
          画像を取り込む
        </button>
        <button type="button" className="button" disabled={!!progress} onClick={() => pick(true)}>
          フォルダを取り込む
        </button>
      </header>

      <Sidebar gallery={data} />

      <Masonry
        root={root}
        images={images}
        thumbWidth={thumbWidth}
        selected={selection.ids}
        onSelect={(id, e) =>
          setSelection((s) => (id === null ? EMPTY_SELECTION : select(s, order, id, { shift: e.shiftKey, meta: e.metaKey })))
        }
      />

      <Detail root={root} categories={data.categories} image={selectedImage} count={selection.ids.size} />

      <footer className="gallery__statusbar">
        <span>{data.images.length}枚</span>
        {loadError && <Status kind="error">一覧を読めません（{loadError}）</Status>}
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
