import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { subtree } from './categoryTree'
import Detail from './Detail'
import { countImages, type Filter, filterImages, NO_FILTER } from './filter'
import MoveFailDialog from './MoveFailDialog'
import Masonry from './Masonry'
import SearchBox from './SearchBox'
import SettingsDialog from './SettingsDialog'
import Sidebar from './Sidebar'
import SkipDialog from './SkipDialog'
import Status from './Status'
import StatusbarResult, { type Failed, type Result } from './StatusbarResult'
import TagDialog from './TagDialog'
import MissingPanel from './MissingPanel'
import TrashPanel from './TrashPanel'
import type {
  Assigned,
  Deleted,
  Detail as DetailData,
  Done,
  Gallery as GalleryData,
  Image,
  Restored,
  Settings,
  Tag,
} from './galleryTypes'
import type { ImportProgress, Report, ScanReport } from './importTypes'
import { EMPTY_SELECTION, keepOnly, select } from './selection'
import { SORTS, type SortKey, sortImages } from './sort'
import './Gallery.css'

const EMPTY: GalleryData = { images: [], categories: [], tags: [] }

// サムネイルの列の幅の目安。上限はサムネイルの幅（320）
const THUMB_MIN = 100
const THUMB_MAX = 320

type Props = {
  root: string
  // アプリ全体の設定。onSettings は保存に失敗したら理由の文字列で reject する
  settings: Settings
  onSettings: (settings: Settings) => Promise<void>
}

export default function Gallery({ root, settings, onSettings }: Props) {
  const [data, setData] = useState(EMPTY)
  const [sort, setSort] = useState<SortKey>('imported')
  const [filter, setFilter] = useState(NO_FILTER)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [selection, setSelection] = useState(EMPTY_SELECTION)
  const [zoom, setZoom] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 読み込んだ詳細。id は、別の画像に移った直後に前の画像の詳細を使わないため
  const [detail, setDetail] = useState<{ id: number; detail?: DetailData; error?: string } | null>(null)
  const busy = useRef(false)
  // ゴミ箱の画像と、ゴミ箱を開いているか（FR-511）
  const [trash, setTrash] = useState<Image[]>([])
  // 見つからない画像（FR-104）
  const [missing, setMissing] = useState<Image[]>([])
  // 一覧の場所に出しているもの。null はギャラリー
  const [aside, setAside] = useState<'trash' | 'missing' | null>(null)
  const inTrash = aside === 'trash'
  const inMissing = aside === 'missing'
  // 差分検出の進み具合。total が0の間は、中身を読むファイルを数えている
  const [scanning, setScanning] = useState<ImportProgress | null>(null)

  const thumbWidth = Math.min(THUMB_MAX, Math.max(THUMB_MIN, settings.thumb_width))
  function changeSettings(next: Partial<Settings>) {
    onSettings({ ...settings, ...next }).catch((e) => setResult({ kind: 'error', message: String(e) }))
  }

  // 読み直した画像を返す。読めなければ空
  async function reload() {
    try {
      const g = await invoke<GalleryData>('load_gallery')
      setData(g)
      setLoadError(null)
      return g.images
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }
  async function reloadTrash() {
    try {
      const t = await invoke<Image[]>('load_trash')
      setTrash(t)
      return t
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }
  async function reloadMissing() {
    try {
      const m = await invoke<Image[]>('load_missing')
      setMissing(m)
      return m
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }

  // 差分検出（FR-104）。ライブラリを開いた後と、サイドバーのボタンで行う
  async function scan() {
    if (busy.current) return
    busy.current = true
    setScanning({ done: 0, total: 0 })
    try {
      setResult({ kind: 'scan', report: await invoke<ScanReport>('scan_library') })
    } catch (e) {
      setResult({ kind: 'error', message: `差分を確認できません（${e}）` })
    }
    busy.current = false
    setScanning(null)
    // 差分検出の間も操作できるので、選択は外さず、なくなった画像だけを外す
    const lists = await Promise.all([reload(), reloadTrash(), reloadMissing()])
    const alive = new Set(lists.flat().map((i) => i.id))
    setSelection((s) => keepOnly(s, alive))
  }

  const scanRef = useRef(scan)
  scanRef.current = scan
  // 差分検出の前に、今の DB の一覧を先に出す。差分検出は時間がかかることがあるため
  useEffect(() => {
    Promise.all([reload(), reloadTrash(), reloadMissing()]).then(() => scanRef.current())
  }, [])

  const sorted = useMemo(() => sortImages(data.images, sort), [data.images, sort])
  const images = useMemo(
    () => filterImages(sorted, data.categories, data.tags, filter),
    [sorted, data.categories, data.tags, filter],
  )
  const counts = useMemo(() => countImages(data.images, data.categories), [data.images, data.categories])
  const filtered = images.length !== data.images.length

  // 絞り込みを変えたら、見えなくなった画像の選択を外す。見えない画像までまとめて変えないため
  function changeFilter(next: Filter) {
    setFilter(next)
    if (aside) {
      setAside(null)
      setSelection(EMPTY_SELECTION)
      return
    }
    const visible = new Set(filterImages(data.images, data.categories, data.tags, next).map((i) => i.id))
    setSelection((s) => keepOnly(s, visible))
  }

  // タグの付け外しとメモを手元の値に反映する。絞り込みと件数は手元の値で数えるため
  const editImages = (ids: number[], edit: (i: Image) => Image) => {
    const targets = new Set(ids)
    setData((d) => ({ ...d, images: d.images.map((i) => (targets.has(i.id) ? edit(i) : i)) }))
  }
  // ゴミ箱と見つからない画像は新しい順に出し、並べ替えと絞り込みはしない
  const listed = inTrash ? trash : inMissing ? missing : images
  const order = useMemo(() => listed.map((i) => i.id), [listed])
  const ids = useMemo(() => [...selection.ids], [selection.ids])
  const pool = listed === images ? data.images : listed
  const selected = useMemo(() => pool.filter((i) => selection.ids.has(i.id)), [pool, selection.ids])
  const only = !aside && ids.length === 1 ? ids[0] : null
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
  const moveTo = useCallback((id: number) => setSelection({ ids: new Set([id]), anchor: id }), [])
  const step = (by: number) => {
    const id = order[at + by]
    if (id !== undefined) moveTo(id)
  }

  // キーボードの操作（FR-508、FR-509、NFR-12）。一覧の矢印キーは Masonry で受ける
  const onKey = (e: KeyboardEvent) => {
    // ダイアログの中の操作は奪わない
    if ((e.target as Element).closest('dialog')) return
    const key = e.key.toLowerCase()
    if (e.metaKey && key === 'f') {
      e.preventDefault()
      document.getElementById('search')?.focus()
      return
    }
    if (e.metaKey && key === ',') {
      e.preventDefault()
      setSettingsOpen(true)
      return
    }
    // 入力中の文字の操作は奪わない
    if ((e.target as Element).closest('input, textarea, select')) return
    const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (e.key === 'Escape') {
      if (zoomed) setZoom(false)
      else setSelection(EMPTY_SELECTION)
    } else if (by && zoomed) {
      e.preventDefault()
      step(by)
    } else if (e.key === ' ') {
      // 一覧のスクロールに使わせない
      e.preventDefault()
      if (zoomed) setZoom(false)
      // ゴミ箱と見つからない画像は、ダブルクリックと同じく拡大表示しない
      else if (selectedImage && !aside) setZoom(true)
    } else if (e.metaKey && key === 'a' && !zoomed) {
      e.preventDefault()
      setSelection({ ids: new Set(order), anchor: order[0] ?? null })
    } else if (e.metaKey && e.key === 'Backspace' && !aside && selection.ids.size) {
      e.preventDefault()
      trashImages([...selection.ids])
    } else if (key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey && selection.ids.size && !aside) {
      // 入力欄に t を入れないよう、既定の動きを止めてから移る
      e.preventDefault()
      document.getElementById('detail-tag')?.focus()
    }
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

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
      // 終わった後に届いた進み具合で、表示を戻さない
      listen<ImportProgress>('scan-progress', (e) => setScanning((s) => s && e.payload)),
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

  const named = (failed: Assigned['failed'], list: Image[]): Failed =>
    failed.map((f) => ({ file_name: list.find((i) => i.id === f.id)?.file_name ?? String(f.id), message: f.message }))

  // 移した画像のカテゴリとファイル名を手元の値に反映し、移せなかった画像をファイル名で返す
  function applyMoved(r: Assigned, category: number | null) {
    const names = new Map(r.moved.map((m) => [m.id, m.file_name]))
    setData((d) => ({
      ...d,
      images: d.images.map((i) => (names.has(i.id) ? { ...i, category_id: category, file_name: names.get(i.id)! } : i)),
    }))
    return named(r.failed, data.images)
  }

  // ゴミ箱（FR-511）。移した画像は手元の一覧から外し、ゴミ箱は読み直す
  async function trashImages(targets: number[]) {
    let r: Done
    try {
      r = await invoke<Done>('trash_images', { ids: targets })
    } catch (e) {
      setResult({ kind: 'error', message: `ゴミ箱へ移せません（${e}）` })
      return
    }
    const gone = new Set(r.done)
    setData((d) => ({ ...d, images: d.images.filter((i) => !gone.has(i.id)) }))
    setSelection((s) => ({ ids: new Set([...s.ids].filter((id) => !gone.has(id))), anchor: null }))
    setResult({ kind: 'trashed', count: r.done.length, failed: named(r.failed, data.images) })
    reloadTrash()
  }

  function openAside(next: 'trash' | 'missing') {
    setAside(next)
    setZoom(false)
    setSelection(EMPTY_SELECTION)
    // タグの統合や削除はゴミ箱と見つからない画像にも効くので、開くたびに読み直す
    if (next === 'trash') reloadTrash()
    else reloadMissing()
  }

  async function forget() {
    let r: Done
    try {
      r = await invoke<Done>('forget_images', { ids })
    } catch (e) {
      setResult({ kind: 'error', message: `DBから外せません（${e}）` })
      return
    }
    setSelection(EMPTY_SELECTION)
    setResult({ kind: 'forgotten', count: r.done.length, failed: named(r.failed, missing) })
    reloadMissing()
  }

  // 戻した画像はタグとメモも含めて一覧に戻るので、両方を読み直す
  async function restoreImages() {
    let r: Restored
    try {
      r = await invoke<Restored>('restore_images', { ids })
    } catch (e) {
      setResult({ kind: 'error', message: `元に戻せません（${e}）` })
      return
    }
    setSelection(EMPTY_SELECTION)
    setResult({
      kind: 'restored',
      count: r.moved.length,
      uncategorized: r.uncategorized.length,
      failed: named(r.failed, trash),
    })
    reload()
    reloadTrash()
  }

  // ids があれば選んだ画像だけを、なければゴミ箱の画像をすべて完全に削除する
  async function purge(targets?: number[]) {
    let r: Done
    try {
      r = await invoke<Done>(targets ? 'purge_images' : 'empty_trash', targets && { ids: targets })
    } catch (e) {
      setResult({ kind: 'error', message: `完全に削除できません（${e}）` })
      return
    }
    setSelection(EMPTY_SELECTION)
    setResult({ kind: 'emptied', count: r.done.length, failed: named(r.failed, trash) })
    reloadTrash()
  }

  async function assign(targets: number[], category: number | null) {
    const r = await invoke<Assigned>('set_category', { ids: targets, category })
    setResult({ kind: 'assigned', moved: r.moved.length, failed: applyMoved(r, category) })
  }

  async function renameImage(id: number, stem: string) {
    const file_name = await invoke<string>('rename_image', { id, stem })
    setData((d) => ({ ...d, images: d.images.map((i) => (i.id === id ? { ...i, file_name } : i)) }))
  }

  // 変わるのはカテゴリの行だけなので、一覧を読み直さずに手元の値を変える
  async function renameCategory(id: number, name: string) {
    await invoke('rename_category', { id, name })
    const nfc = name.normalize('NFC')
    setData((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, name: nfc } : c)) }))
  }

  async function createCategory(parent: number | null, name: string) {
    const id = await invoke<number>('create_category', { parent, name })
    setData((d) => ({
      ...d,
      categories: [...d.categories, { id, name: name.normalize('NFC'), parent_id: parent, collapsed: false }],
    }))
  }

  async function moveCategory(id: number, parent: number | null) {
    try {
      await invoke('move_category', { id, parent })
      setData((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, parent_id: parent } : c)) }))
    } catch (e) {
      setResult({ kind: 'error', message: `カテゴリを移せません（${e}）` })
    }
  }

  async function collapseCategories(ids: number[], collapsed: boolean) {
    const set = new Set(ids)
    setData((d) => ({ ...d, categories: d.categories.map((c) => (set.has(c.id) ? { ...c, collapsed } : c)) }))
    // 開閉を覚えられなくても操作は続けられるので、知らせるだけにする
    await invoke('set_categories_collapsed', { ids, collapsed }).catch((e) =>
      setResult({ kind: 'error', message: `カテゴリの開閉を保存できません（${e}）` }),
    )
  }

  async function deleteCategory(id: number) {
    const name = data.categories.find((c) => c.id === id)?.name ?? ''
    let r: Deleted
    try {
      r = await invoke<Deleted>('delete_category', { id })
    } catch (e) {
      setResult({ kind: 'error', message: `カテゴリを削除できません（${e}）` })
      return
    }
    const failed = applyMoved(r, null)
    if (r.error !== null) {
      setResult({ kind: 'error', message: `「${name}」を削除できません（${r.error}）`, failed })
      return
    }
    setData((d) => {
      const gone = subtree(d.categories, id)
      return { ...d, categories: d.categories.filter((c) => !gone.has(c.id)) }
    })
    setResult({ kind: 'deleted', name, moved: r.moved.length })
  }

  const addTag = (tag: Tag) =>
    setData((d) => (d.tags.some((t) => t.id === tag.id) ? d : { ...d, tags: sortTags([...d.tags, tag]) }))

  // タグ管理（FR-408）。変わるのはタグの行と画像のタグだけなので、一覧を読み直さずに手元の値を変える
  const [managingTags, setManagingTags] = useState(false)
  async function renameTag(id: number, name: string) {
    const tag = await invoke<Tag>('rename_tag', { id, name })
    setData((d) => ({ ...d, tags: sortTags(d.tags.map((t) => (t.id === id ? tag : t))) }))
  }
  // from のタグを画像と絞り込みの条件から外す。into があれば代わりに付ける
  function dropTag(from: number, into: number | null) {
    const swap = (tags: number[]) =>
      tags.includes(from) ? [...new Set(tags.flatMap((t) => (t === from ? (into === null ? [] : [into]) : [t])))] : tags
    setData((d) => ({
      ...d,
      tags: d.tags.filter((t) => t.id !== from),
      images: d.images.map((i) => (i.tags.includes(from) ? { ...i, tags: swap(i.tags) } : i)),
    }))
    setFilter((f) => ({ ...f, tags: swap(f.tags) }))
  }
  async function mergeTag(from: number, into: number) {
    await invoke('merge_tag', { from, into })
    dropTag(from, into)
  }
  async function deleteTag(id: number) {
    await invoke('delete_tag', { id })
    dropTag(id, null)
  }

  const skipped = result?.kind === 'report' || result?.kind === 'scan' ? result.report.skipped : []

  return (
    <div className="gallery">
      <header className="gallery__header">
        <span className="gallery__logo">Kura</span>
        <SearchBox filter={filter} categories={data.categories} tags={data.tags} onFilter={changeFilter} />
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
          onChange={(e) => changeSettings({ thumb_width: Number(e.target.value) })}
        />
        {/* 取り込みと差分検出の間は、押せないボタンを残さず処理中であることを出す。押せない理由がわからないと壊れたと思われるため。
            ボタンは見えないまま場所を取り、ヘッダーの幅が変わらないようにする */}
        <span className="gallery__import">
          <span className="gallery__import-buttons" hidden={!!(scanning || progress)}>
            <button type="button" className="button" onClick={() => pick(false)}>
              画像を取り込む
            </button>
            <button type="button" className="button" onClick={() => pick(true)}>
              フォルダを取り込む
            </button>
          </span>
          {(scanning || progress) && (
            <span className="gallery__busy" role="status">
              <Spinner />
              {scanning ? 'Finder での変更を反映中…' : '取り込み中…'}
            </span>
          )}
        </span>
        <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
          設定
        </button>
      </header>

      <Sidebar
        gallery={data}
        filter={filter}
        counts={counts}
        onFilter={changeFilter}
        onManageTags={() => setManagingTags(true)}
        onRename={renameCategory}
        onCreate={createCategory}
        onMove={moveCategory}
        onDelete={deleteCategory}
        onCollapse={collapseCategories}
        confirmMove={settings.confirm_category_move}
        onSkipConfirm={() => changeSettings({ confirm_category_move: false })}
        trashCount={trash.length}
        missingCount={missing.length}
        aside={aside}
        onAside={openAside}
        scanning={!!scanning || !!progress}
        onScan={scan}
      />

      <Masonry
        root={root}
        images={listed}
        empty={
          !aside && filtered
            ? '条件に合う画像がありません'
            : '画像がありません。「画像を取り込む」を押すか、画像をここにドロップしてください'
        }
        thumbWidth={thumbWidth}
        selected={selection.ids}
        onSelect={(id, e) =>
          setSelection((s) =>
            id === null ? EMPTY_SELECTION : select(s, order, id, { shift: e.shiftKey, meta: e.metaKey }),
          )
        }
        // ゴミ箱の元の画像は画面から読めず、見つからない画像は元の画像がないので、拡大表示しない
        onOpen={() => !aside && setZoom(true)}
        active={selection.anchor}
        keys={!zoomed}
        onMove={moveTo}
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

      {inTrash ? (
        <TrashPanel
          count={trash.length}
          selected={ids.length}
          name={selected.length === 1 ? selected[0].file_name : undefined}
          onRestore={restoreImages}
          onPurge={() => purge(ids)}
          onEmpty={() => purge()}
        />
      ) : inMissing ? (
        <MissingPanel
          selected={ids.length}
          name={selected.length === 1 ? selected[0].file_name : undefined}
          onForget={forget}
        />
      ) : (
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
          onRename={renameImage}
          onTagCreated={addTag}
          onTagged={(tag, ids) => editImages(ids, (i) => (i.tags.includes(tag) ? i : { ...i, tags: [...i.tags, tag] }))}
          onUntagged={(tag, ids) => editImages(ids, (i) => ({ ...i, tags: i.tags.filter((t) => t !== tag) }))}
          onMemo={(id, memo) => editImages([id], (i) => ({ ...i, memo }))}
          onTrash={trashImages}
        />
      )}

      <footer className="gallery__statusbar">
        <span>
          {inTrash
            ? `ゴミ箱 ${trash.length}枚`
            : inMissing
              ? `見つからない ${missing.length}枚`
              : filtered
                ? `${images.length} / ${data.images.length}枚`
                : `${data.images.length}枚`}
        </span>
        {loadError && <Status kind="error">一覧を読めません（{loadError}）</Status>}
        <StatusbarResult
          scanning={scanning}
          progress={progress}
          result={result}
          onShowFailed={() => setShowSkipped(true)}
          onShowMissing={() => openAside('missing')}
        />
      </footer>

      {settingsOpen && (
        <SettingsDialog
          root={root}
          settings={settings}
          onSettings={changeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {managingTags && (
        <TagDialog
          tags={data.tags}
          counts={counts.tags}
          onRename={renameTag}
          onMerge={mergeTag}
          onDelete={deleteTag}
          onClose={() => setManagingTags(false)}
        />
      )}

      {showSkipped &&
        (result && result.kind !== 'report' && result.kind !== 'scan' && result.kind !== 'deleted' ? (
          <MoveFailDialog
            title={
              result.kind === 'emptied'
                ? '削除できなかった画像'
                : result.kind === 'forgotten'
                  ? 'DBから外せなかった画像'
                  : undefined
            }
            failed={result.failed ?? []}
            onClose={() => setShowSkipped(false)}
          />
        ) : (
          <SkipDialog
            title={result?.kind === 'scan' ? '登録しなかったファイル' : undefined}
            skipped={skipped}
            onClose={() => setShowSkipped(false)}
          />
        ))}
    </div>
  )
}

const sortTags = (tags: Tag[]) => tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))

// 処理中を示す、回る円弧のアイコン
const Spinner = () => (
  <svg
    className="spinner"
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 3a9 9 0 1 1-9 9" />
  </svg>
)

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
