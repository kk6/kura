import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open } from '@tauri-apps/plugin-dialog'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { subtree } from './categoryTree'
import { useContextMenu } from './contextMenu'
import { flushAll } from './flush'
import { Icon, ICONS } from './icons'
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
import type { Backfill, BackfillCounts, ImportProgress, Report, ScanReport } from './importTypes'
import { EMPTY_SELECTION, keepOnly, select } from './selection'
import { SORTS, type SortKey, sortImages } from './sort'
import './Gallery.css'

// 追加先のダイアログはボードの画面の一部なので、ボードを使わない起動では読み込まない（FR-711）
const AddDialog = lazy(() => import('./board/AddDialog'))

const EMPTY: GalleryData = { images: [], categories: [], tags: [] }

// サムネイルの列の幅の目安。上限はサムネイルの幅（320）
const THUMB_MIN = 100
const THUMB_MAX = 320

type Props = {
  root: string
  // 最近使ったライブラリ。ヘッダーのライブラリのメニューに出す（FR-105）
  recent: string[]
  // アプリ全体の設定。onSettings は保存に失敗したら理由の文字列で reject する
  settings: Settings
  onSettings: (settings: Settings) => Promise<void>
  // path のライブラリへ切り替える。path がなければライブラリ選択画面へ戻る（FR-105）
  onSwitch: (path?: string) => void
}

export default function Gallery({ root, recent, settings, onSettings, onSwitch }: Props) {
  const [data, setData] = useState(EMPTY)
  const [sort, setSort] = useState<SortKey>('imported')
  const [filter, setFilter] = useState(NO_FILTER)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [selection, setSelection] = useState(EMPTY_SELECTION)
  const [zoom, setZoom] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 詳細パネルを開いているか。保存せず、起動すると開いた状態に戻る
  const [detailOpen, setDetailOpen] = useState(true)
  // 開閉の動きの途中か。閉じる動きの間はパネルを残し、動き終わってから外す
  const [detailMotion, setDetailMotion] = useState<'opening' | 'closing' | null>(null)
  const detailShown = detailOpen && detailMotion !== 'closing'
  function toggleDetail(open = !detailShown) {
    // 動きを減らす設定では animationend が来ないので、すぐ切り替える
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (open) {
      setDetailOpen(true)
      setDetailMotion(still ? null : 'opening')
    } else if (still) setDetailOpen(false)
    else setDetailMotion('closing')
  }
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
  // 元URLの補完（FR-208）。終わった後も、設定を開き直したときに結果を出すため残す
  const [backfill, setBackfill] = useState<Backfill | null>(null)
  // 補完を終えた回数。補完した元URLを詳細パネルに出すため、詳細を読み直す
  const [backfilled, setBackfilled] = useState(0)

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
    // 差分検出の間も操作できるので、選択は外さない。今の一覧から消えた画像の選択は下の effect が外す
    await Promise.all([reload(), reloadTrash(), reloadMissing()])
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

  // 絞り込みで見えなくなった画像の選択は、下の effect が外す。見えない画像までまとめて変えないため
  function changeFilter(next: Filter) {
    setFilter(next)
    if (aside) {
      setAside(null)
      setSelection(EMPTY_SELECTION)
    }
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
  // 今の一覧にない画像の選択を外す。差分確認で「見つからない」の画像が戻ったときなどに、
  // 見えない画像を選んだまま詳細パネルに「N枚を選んでいます」と出さない
  useEffect(() => setSelection((s) => keepOnly(s, new Set(order))), [order])
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
  }, [only, place, backfilled])

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
    if (e.metaKey && key === 'i') {
      e.preventDefault()
      toggleDetail()
      return
    }
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

  // 補完の間、取り込み・差分検出・ファイルを動かす操作・ライブラリ切り替えは Rust 側で補完の終了か中断を待つ
  async function startBackfill() {
    setBackfill({ running: true, counts: null, error: null })
    try {
      const counts = await invoke<BackfillCounts>('backfill_sources')
      setBackfill({ running: false, counts, error: null })
    } catch (e) {
      setBackfill((b) => ({ running: false, counts: b?.counts ?? null, error: String(e) }))
    }
    setBackfilled((n) => n + 1)
  }

  // 取り込みと差分検出の途中では戻らない。どちらも開いているライブラリを1枚ずつ読み書きするため
  function leave(path?: string) {
    // メニューのショートカットはダイアログの間も届く。ほかのショートカットと同じく、ダイアログの間は効かせない
    if (document.querySelector('dialog[open]')) return
    // ステータスバーは処理の間は進み具合を出すので、断る理由はダイアログで知らせる
    if (busy.current) {
      message('取り込みか Finder での変更の反映が終わってから、もう一度選んでください。', {
        title: 'ライブラリを切り替えられません',
        kind: 'warning',
      })
      return
    }
    // 入力中のメモとボードを保存し終えてから切り替える。ライブラリは次に開くまで Rust 側に残るので、
    // 保存は前のライブラリに届く。保存できなければ切り替えない（FR-105、FR-411）。メモの失敗は入力欄の下に出す
    flushAll()
      .then(
        () =>
          invoke('close_board_window').catch((e) => {
            throw `ボードを保存できないため、ライブラリを切り替えられません（${e}）`
          }),
        () => {
          throw 'メモを保存できないため、ライブラリを切り替えられません'
        },
      )
      .then(
        () => onSwitch(path),
        (e) => setResult({ kind: 'error', message: String(e) }),
      )
  }
  const leaveRef = useRef(leave)
  leaveRef.current = leave

  // 画像を選んでいても追加はせず、専用ウィンドウを開くだけにする（FR-701）
  function openBoard() {
    if (!settings.board_enabled) return
    invoke('show_board_window').catch((e) => setResult({ kind: 'error', message: String(e) }))
  }
  const openBoardRef = useRef(openBoard)
  openBoardRef.current = openBoard

  // 「ボードに追加」の追加先ダイアログに渡す画像（FR-701）。ゴミ箱と見つからない画像は追加できない
  const [adding, setAdding] = useState<number[] | null>(null)
  const canAdd = settings.board_enabled && !aside && ids.length > 0
  function addToBoard() {
    // メニューのショートカットはダイアログの間も届く。ほかのショートカットと同じく、ダイアログの間は効かせない
    if (!canAdd || document.querySelector('dialog[open]')) return
    setMenuAt(null)
    setAdding(ids)
  }
  const addRef = useRef(addToBoard)
  addRef.current = addToBoard
  // Rust に知らせ、メニューの「ボードに追加…」の有効・無効と、ダイアログの間にボードの最前面の固定を
  // 外すのに使う。固定したボードの後ろにダイアログが隠れないように（FR-701、FR-705）
  const dialogOpen = useDialogOpen()
  useEffect(() => {
    invoke('report_gallery', { addable: canAdd, dialog: dialogOpen }).catch((e) => console.error(e))
  }, [canAdd, dialogOpen])
  useEffect(
    () => () => {
      invoke('report_gallery', { addable: false, dialog: false }).catch((e) => console.error(e))
    },
    [],
  )

  const { at: menuAt, setAt: setMenuAt, ref: contextMenu } = useContextMenu()
  function openContextMenu(id: number, e: React.MouseEvent) {
    if (!settings.board_enabled || aside) return
    e.preventDefault()
    // 右クリックした画像を選んでいなければ、その画像だけを選ぶ（Finder と同じ）
    if (!selection.ids.has(id)) setSelection({ ids: new Set([id]), anchor: id })
    setMenuAt({ x: e.clientX, y: e.clientY })
  }
  // ボードの「ギャラリーで表示」（FR-701）。絞り込みを外して画像を選び、見える所までスクロールする。
  // ゴミ箱と見つからない画像は、その一覧を開いて選ぶ
  const [revealed, setRevealed] = useState<{ id: number } | null>(null)
  function revealImage(id: number) {
    // 確認のダイアログは開いたときの選択を対象にする。その下で選択を変えない
    if (document.querySelector('dialog[open]')) return
    const next = trash.some((i) => i.id === id) ? 'trash' : missing.some((i) => i.id === id) ? 'missing' : null
    if (!next && !data.images.some((i) => i.id === id)) {
      setResult({ kind: 'error', message: '画像がギャラリーにありません。差分を確認してから、もう一度試してください' })
      return
    }
    setMenuAt(null)
    setZoom(false)
    setAside(next)
    if (!next) setFilter(NO_FILTER)
    setSelection({ ids: new Set([id]), anchor: id })
    setRevealed({ id })
  }
  const revealRef = useRef(revealImage)
  revealRef.current = revealImage
  useEffect(() => {
    const unlisten = [
      // このウィンドウ宛てのイベントは、ウィンドウの listen で受ける
      getCurrentWindow().listen<number>('gallery-reveal', (e) => revealRef.current(e.payload)),
      // 終わった後に届いた進み具合で、結果を戻さない
      getCurrentWindow().listen<BackfillCounts>('backfill-progress', (e) =>
        setBackfill((b) => (b?.running ? { ...b, counts: e.payload } : b)),
      ),
      listen<ImportProgress>('import-progress', (e) => setProgress(e.payload)),
      // 終わった後に届いた進み具合で、表示を戻さない
      listen<ImportProgress>('scan-progress', (e) => setScanning((s) => s && e.payload)),
      listen('switch-library', () => leaveRef.current()),
      listen('open-board', () => openBoardRef.current()),
      // 操作の対象は手前のウィンドウ。ボードのウィンドウが手前なら追加しない
      listen('add-to-board', () => document.hasFocus() && addRef.current()),
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
      setResult({ kind: 'error', message: `一覧から外せません（${e}）` })
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

  const reveal = (id?: number) =>
    invoke('show_in_finder', { id }).catch((e) => setResult({ kind: 'error', message: `Finder で開けません（${e}）` }))

  const title = inTrash
    ? 'ゴミ箱'
    : inMissing
      ? '見つからない'
      : filter.category === 'all'
        ? 'すべての画像'
        : filter.category === 'uncategorized'
          ? '未分類'
          : (data.categories.find((c) => c.id === filter.category)?.name ?? '')

  const skipped = result?.kind === 'report' || result?.kind === 'scan' ? result.report.skipped : []

  return (
    <div
      className={
        'gallery' + (detailOpen ? '' : ' gallery--no-detail') + (detailMotion ? ` gallery--detail-${detailMotion}` : '')
      }
      onAnimationEnd={(e) => {
        if (e.animationName === 'detail-out') setDetailOpen(false)
        if (e.animationName === 'detail-in' || e.animationName === 'detail-out') setDetailMotion(null)
      }}
    >
      <header className="gallery__header">
        <span className="gallery__brand">
          <span className="gallery__mark">
            <Icon d={ICONS.kura} size={28} />
          </span>
          <span className="gallery__brand-text">
            <span className="gallery__logo">Kura</span>
            {/* ネイティブのメニューにすると、今のライブラリに macOS のチェックが付く */}
            <select
              className="gallery__library"
              aria-label="ライブラリ"
              title={root}
              value={root}
              onChange={(e) => leave(e.target.value || undefined)}
            >
              <optgroup label="最近使ったライブラリ">
                {(recent.includes(root) ? recent : [root, ...recent]).map((path) => (
                  <option key={path} value={path}>
                    {baseName(path)}
                  </option>
                ))}
              </optgroup>
              <option value="">ほかのライブラリを開く…</option>
            </select>
          </span>
        </span>
        <SearchBox filter={filter} categories={data.categories} tags={data.tags} onFilter={changeFilter} />
        {/* 取り込みと差分検出の間は、押せないボタンを残さず処理中であることを出す。押せない理由がわからないと壊れたと思われるため。
            ボタンは見えないまま場所を取り、ヘッダーの幅が変わらないようにする */}
        <span className="gallery__import">
          <span className="gallery__import-buttons" hidden={!!(scanning || progress)}>
            <button type="button" className="button" onClick={() => pick(false)}>
              <Icon d={ICONS.imagePlus} />
              画像を取り込む
            </button>
            <button type="button" className="button" onClick={() => pick(true)}>
              <Icon d={ICONS.folderPlus} />
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
        {settings.board_enabled && (
          <button type="button" className="button button--primary" title="アイデアボード（⌘B）" onClick={openBoard}>
            <Icon d={ICONS.board} />
            アイデアボード
          </button>
        )}
        <button
          type="button"
          className="button button--icon"
          aria-label="設定"
          title="設定（⌘,）"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon d={ICONS.settings} />
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
        root={root}
        onReveal={() => reveal()}
        tagsCollapsed={settings.tags_collapsed}
        onTagsCollapse={(tags_collapsed) => changeSettings({ tags_collapsed })}
      />

      <div className="gallery__toolbar">
        <h1 className="toolbar__title">{title}</h1>
        <span className="toolbar__count">{listed.length}枚</span>
        <span className="toolbar__spacer" />
        {!aside && (
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
        )}
        <input
          className="slider"
          type="range"
          aria-label="サムネイルの大きさ"
          min={THUMB_MIN}
          max={THUMB_MAX}
          step={10}
          value={thumbWidth}
          onChange={(e) => changeSettings({ thumb_width: Number(e.target.value) })}
        />
        <button
          type="button"
          className="button button--icon"
          aria-label={detailShown ? '詳細パネルを閉じる' : '詳細パネルを開く'}
          aria-pressed={detailShown}
          title={`詳細パネルを${detailShown ? '閉じる' : '開く'}（⌘I）`}
          onClick={() => toggleDetail()}
        >
          <Icon d={ICONS.panelRight} />
        </button>
      </div>

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
        onContextMenu={openContextMenu}
        active={selection.anchor}
        reveal={revealed}
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

      {/* 閉じる動きの間は、フォーカスもクリックも受けない */}
      <div className="gallery__detail-slot" inert={detailMotion === 'closing'}>
        {!detailOpen ? null : inTrash ? (
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
            onTagged={(tag, ids) =>
              editImages(ids, (i) => (i.tags.includes(tag) ? i : { ...i, tags: [...i.tags, tag] }))
            }
            onUntagged={(tag, ids) => editImages(ids, (i) => ({ ...i, tags: i.tags.filter((t) => t !== tag) }))}
            onMemo={(id, memo) => editImages([id], (i) => ({ ...i, memo }))}
            onTrash={trashImages}
            onReveal={reveal}
            onAddToBoard={settings.board_enabled ? addToBoard : undefined}
            onClose={() => toggleDetail(false)}
          />
        )}
      </div>

      <footer className="gallery__statusbar">
        <span>
          {inTrash
            ? `ゴミ箱 ${trash.length}枚`
            : inMissing
              ? `見つからない ${missing.length}枚`
              : filtered
                ? `${images.length} / ${data.images.length}枚`
                : `${data.images.length}枚`}
          {ids.length > 0 && ` ・ ${ids.length}枚を選択`}
        </span>
        {loadError && <Status kind="error">一覧を読めません（{loadError}）</Status>}
        <StatusbarResult
          backfill={backfill?.running ? backfill : null}
          scanning={scanning}
          progress={progress}
          result={result}
          onShowFailed={() => setShowSkipped(true)}
          onShowMissing={() => openAside('missing')}
          onShowNotes={() => setShowNotes(true)}
        />
      </footer>

      {menuAt && (
        <div ref={contextMenu} className="menu" role="menu" popover="manual" style={{ top: menuAt.y, left: menuAt.x }}>
          <button type="button" role="menuitem" className="menu__item" onClick={addToBoard}>
            ボードに追加…
          </button>
        </div>
      )}
      {adding && (
        <Suspense fallback={null}>
          <AddDialog images={adding} onClose={() => setAdding(null)} />
        </Suspense>
      )}

      {settingsOpen && (
        <SettingsDialog
          root={root}
          settings={settings}
          onSettings={changeSettings}
          backfill={backfill}
          busy={!!(scanning || progress)}
          onBackfill={startBackfill}
          onCancelBackfill={() => invoke('cancel_backfill')}
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

      {showNotes && (result?.kind === 'report' || result?.kind === 'scan') && (
        <MoveFailDialog
          title="元URLの注意"
          kind="warning"
          failed={result.report.source_notes.map((n) => ({ file_name: n.path, message: n.message }))}
          onClose={() => setShowNotes(false)}
        />
      )}
      {showSkipped &&
        (result && result.kind !== 'report' && result.kind !== 'scan' && result.kind !== 'deleted' ? (
          <MoveFailDialog
            title={
              result.kind === 'emptied'
                ? '削除できなかった画像'
                : result.kind === 'forgotten'
                  ? '一覧から外せなかった画像'
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

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

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

// このウィンドウで dialog 要素を開いているか
function useDialogOpen() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const observer = new MutationObserver(() => setOpen(document.querySelector('dialog[open]') !== null))
    observer.observe(document.body, { subtree: true, childList: true, attributeFilter: ['open'] })
    return () => observer.disconnect()
  }, [])
  return open
}
