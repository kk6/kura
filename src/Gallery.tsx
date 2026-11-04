import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import Detail from './Detail'
import MoveFailDialog from './MoveFailDialog'
import Masonry from './Masonry'
import Sidebar from './Sidebar'
import SkipDialog from './SkipDialog'
import Status from './Status'
import type { Assigned, Detail as DetailData, Gallery as GalleryData, Tag } from './galleryTypes'
import type { ImportProgress, Report } from './importTypes'
import { EMPTY_SELECTION, select } from './selection'
import { SORTS, type SortKey, sortImages } from './sort'
import './Gallery.css'

// ステータスバーに出す一括操作の結果
type Result =
  | { kind: 'report'; report: Report }
  | { kind: 'error'; message: string }
  | { kind: 'assigned'; moved: number; failed: { file_name: string; message: string }[] }

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
  const [zoom, setZoom] = useState(false)
  // 読み込んだ詳細。id は、別の画像に移った直後に前の画像の詳細を使わないため
  const [detail, setDetail] = useState<{ id: number; detail?: DetailData; error?: string } | null>(null)
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
  const ids = useMemo(() => [...selection.ids], [selection.ids])
  const selected = useMemo(() => data.images.filter((i) => selection.ids.has(i.id)), [data.images, selection.ids])
  const only = ids.length === 1 ? ids[0] : null
  const selectedImage = only === null ? null : (selected[0] ?? null)
  const shown = detail && detail.id === only ? detail : null
  // カテゴリを変えるとファイルの場所が変わるので、詳細（拡大表示で読む元の画像のパス）を読み直す
  const place = selectedImage && `${selectedImage.category_id}/${selectedImage.file_name}`

  useEffect(() => {
    if (only === null) return
    let current = true
    invoke<DetailData>('image_detail', { id: only }).then(
      (d) => current && setDetail({ id: only, detail: d }),
      (e) => current && setDetail({ id: only, error: String(e) }),
    )
    return () => {
      current = false
    }
  }, [only, place])

  // 拡大表示（FR-508）。左右キーか左右の端のボタンで、今の並び順の前後の画像に移る
  const zoomed = zoom ? selectedImage : null
  const at = zoomed ? order.indexOf(zoomed.id) : -1
  const step = (by: number) => {
    const id = order[at + by]
    if (id !== undefined) setSelection({ ids: new Set([id]), anchor: id })
  }
  const stepRef = useRef(step)
  stepRef.current = step

  // Escape は拡大表示を閉じ、拡大表示でなければ選択を外す（FR-509）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 入力中の文字の操作と、ダイアログを閉じる Escape は奪わない
      if ((e.target as Element).closest('input, textarea, select, dialog')) return
      const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
      if (e.key === 'Escape') {
        if (zoomed) setZoom(false)
        else setSelection(EMPTY_SELECTION)
      } else if (by && zoomed) {
        e.preventDefault()
        stepRef.current(by)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

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

  async function assign(targets: number[], category: number | null) {
    const r = await invoke<Assigned>('set_category', { ids: targets, category })
    const names = new Map(r.moved.map((m) => [m.id, m.file_name]))
    const failed = r.failed.map((f) => ({
      file_name: data.images.find((i) => i.id === f.id)?.file_name ?? String(f.id),
      message: f.message,
    }))
    setData((d) => ({
      ...d,
      images: d.images.map((i) => (names.has(i.id) ? { ...i, category_id: category, file_name: names.get(i.id)! } : i)),
    }))
    setResult({ kind: 'assigned', moved: r.moved.length, failed })
  }

  const addTag = (tag: Tag) =>
    setData((d) =>
      d.tags.some((t) => t.id === tag.id)
        ? d
        : { ...d, tags: [...d.tags, tag].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id)) },
    )

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
        onOpen={() => setZoom(true)}
      />

      {zoomed && (
        <section className="gallery__zoom" aria-label="拡大表示">
          <img
            className="zoom__image"
            // 元の画像のパスがわかるまではサムネイルを出す
            src={convertFileSrc(shown?.detail?.path ?? `${root}/.kura/thumbs/${zoomed.hash}.jpg`)}
            alt={zoomed.file_name}
            style={{
              // 小さい画像も枠いっぱいに広げ、縦横比を保ったまま収める
              width: `min(100cqw, calc(100cqh * ${zoomed.width / zoomed.height}))`,
              aspectRatio: `${zoomed.width} / ${zoomed.height}`,
              background: zoomed.color,
            }}
          />
          {at > 0 && (
            <button type="button" className="zoom__nav zoom__nav--prev" aria-label="前の画像" onClick={() => step(-1)}>
              <span className="zoom__arrow">
                <Chevron d="M15 6l-6 6 6 6" />
              </span>
            </button>
          )}
          {at < order.length - 1 && (
            <button type="button" className="zoom__nav zoom__nav--next" aria-label="次の画像" onClick={() => step(1)}>
              <span className="zoom__arrow">
                <Chevron d="M9 6l6 6-6 6" />
              </span>
            </button>
          )}
          <button type="button" className="button zoom__close" onClick={() => setZoom(false)}>
            閉じる
          </button>
        </section>
      )}

      <Detail
        root={root}
        categories={data.categories}
        tags={data.tags}
        ids={ids}
        selected={selected}
        image={selectedImage}
        detail={shown?.detail ?? null}
        error={shown?.error ?? null}
        onRate={async (id, rating) => {
          await invoke('set_rating', { id, rating })
          setData((d) => ({ ...d, images: d.images.map((i) => (i.id === id ? { ...i, rating } : i)) }))
        }}
        onAssign={assign}
        onTagCreated={addTag}
      />

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
          ) : result?.kind === 'assigned' ? (
            <>
              <Status kind="success">カテゴリを変更 {result.moved}枚</Status>
              {result.failed.length > 0 && (
                <button type="button" className="statusbar__link" onClick={() => setShowSkipped(true)}>
                  <Status kind="error">移せない {result.failed.length}枚</Status>
                </button>
              )}
            </>
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

      {showSkipped &&
        (result?.kind === 'assigned' ? (
          <MoveFailDialog failed={result.failed} onClose={() => setShowSkipped(false)} />
        ) : (
          <SkipDialog skipped={skipped} onClose={() => setShowSkipped(false)} />
        ))}
    </div>
  )
}

const Chevron = ({ d }: { d: string }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
)
