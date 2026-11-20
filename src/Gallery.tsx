import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open } from '@tauri-apps/plugin-dialog'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { rememberTag } from './choices'
import ConfirmDialog from './ConfirmDialog'
import { ACTION_LABELS, type ImageAction, imageMenu, useContextMenu } from './contextMenu'
import { flushAll } from './flush'
import { Icon, ICONS } from './icons'
import GalleryHeader from './GalleryHeader'
import GalleryToolbar, { THUMB_MAX, THUMB_MIN, ThumbSlider, WeightSliders } from './GalleryToolbar'
import { addTag, dropTag, editImages, named, removeImages, swapTag } from './galleryData'
import Detail, { NOT_COMPUTED } from './Detail'
import { countImages, type Filter, filterImages, NO_FILTER } from './filter'
import MoveFailDialog from './MoveFailDialog'
import Masonry from './Masonry'
import SettingsDialog from './SettingsDialog'
import Sidebar from './Sidebar'
import SkipDialog from './SkipDialog'
import Status from './Status'
import StatusbarResult, { FeaturesProgress, type Result } from './StatusbarResult'
import TagDialog from './TagDialog'
import MissingPanel from './MissingPanel'
import TrashPanel from './TrashPanel'
import type { Boards } from './board/types'
import type { Detail as DetailData, Done, Image, Restored, Settings } from './galleryTypes'
import type {
  Backfill,
  BackfillCounts,
  FeaturesStatus,
  ImportProgress,
  ModelFetch,
  Report,
  ScanReport,
} from './importTypes'
import { EMPTY_SELECTION, keepOnly, select } from './selection'
import { changeWeight, fillWeights, rankSimilar, type Similar, type Weights } from './similarity'
import { type SortKey, sortImages } from './sort'
import { useLibrary } from './useLibrary'
import { useZoom, ZOOM_STEP } from './useZoom'
import { IMAGE_DRAG } from './imageDrag'
import { actualSize, FIT } from './zoomView'
import ZoomPanel, { ZoomSlider } from './ZoomPanel'
import './Gallery.css'

// 追加先のダイアログはボードの画面の一部なので、ボードを使わない起動では読み込まない（FR-711）
const AddDialog = lazy(() => import('./board/AddDialog'))

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

const FEATURES_IDLE: FeaturesStatus = { running: false, done: 0, total: 0, failed: 0, error: null }

export default function Gallery({ root, recent, settings, onSettings, onSwitch }: Props) {
  const [sort, setSort] = useState<SortKey>('imported')
  // 詳細パネルの最近使ったタグ。起動の間だけ覚える（ライブラリを開き直すと Gallery ごと作り直すので空に戻る）
  const [recentTags, setRecentTags] = useState<number[]>([])
  const [filter, setFilter] = useState(NO_FILTER)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const lib = useLibrary(setResult)
  const { data, trash, missing, loadError, reload, reloadTrash, reloadMissing } = lib
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
  // 類似画像検索のモデルのダウンロード。補完と同じく、設定を閉じても続き、開き直すと進み具合を出す
  const [modelFetch, setModelFetch] = useState<ModelFetch | null>(null)
  // 特徴量の計算の状況（FR-604）。計算は Rust のきっかけで始まるので、画面は見せるだけにする
  const [features, setFeatures] = useState<FeaturesStatus>(FEATURES_IDLE)
  // 画面を開いたときと設定を開いたときに読み、その後は features-progress で受け取る
  useEffect(() => {
    invoke<FeaturesStatus>('features_status')
      .then(setFeatures)
      .catch((e) => console.error(e))
  }, [settingsOpen])

  const thumbWidth = Math.min(THUMB_MAX, Math.max(THUMB_MIN, settings.thumb_width))
  function changeSettings(next: Partial<Settings>) {
    onSettings({ ...settings, ...next }).catch((e) => setResult({ kind: 'error', message: String(e) }))
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

  // 差分検出の前に、今の DB の一覧を先に出す。差分検出は時間がかかることがあるため
  useEffect(() => {
    Promise.all([reload(), reloadTrash(), reloadMissing()]).then(() => latest.current.scan())
  }, [reload, reloadTrash, reloadMissing])

  // 類似画像検索の結果のモード（FR-601）。押したときの1回分を持ち、計算が進んでも読み直さない
  const [similar, setSimilar] = useState<(Similar & { base: number; image: Image }) | null>(null)
  // 重み（FR-602）。動かしている間はここだけを変え、手を離したら設定に保存する
  const [weights, setWeights] = useState<Weights>({})
  // スライダーの動きを、2万枚の並べ直しで待たせない
  const ranking = useDeferredValue(weights)
  const rankedIds = useMemo(() => similar && rankSimilar(similar, ranking), [similar, ranking])
  const byId = useMemo(() => new Map(data.images.map((i) => [i.id, i])), [data.images])
  // ゴミ箱へ移した画像などは手元の一覧から消えているので、結果からも外す
  const ranked = useMemo(() => rankedIds?.flatMap((id) => byId.get(id) ?? []), [rankedIds, byId])

  const sorted = useMemo(() => sortImages(data.images, sort), [data.images, sort])
  // 結果のモードでも、サイドバーのカテゴリ・タグと検索バーで絞り込む（FR-603）
  const images = useMemo(
    () => filterImages(ranked ?? sorted, data.categories, data.tags, filter, settings.category_children),
    [ranked, sorted, data.categories, data.tags, filter, settings.category_children],
  )
  const counts = useMemo(
    () => countImages(data.images, data.categories, settings.category_children),
    [data.images, data.categories, settings.category_children],
  )
  // 全体の枚数。結果のモードでは、結果の枚数（特徴量のある画像）
  const whole = ranked ?? data.images
  const filtered = images.length !== whole.length

  // 絞り込みで見えなくなった画像の選択は、下の effect が外す。見えない画像までまとめて変えないため
  function changeFilter(next: Filter) {
    setFilter(next)
    if (aside) {
      setAside(null)
      setSelection(EMPTY_SELECTION)
    }
  }

  // ゴミ箱と見つからない画像は新しい順に出し、並べ替えと絞り込みはしない
  const listed = inTrash ? trash : inMissing ? missing : images
  // 一覧のスクロールを先頭に戻す契機。画像の中身（タグ・メモなど）の変化では戻さない
  const listKey = JSON.stringify([sort, filter, aside, similar?.base ?? null])
  // 結果のモードに入る前の一覧のスクロールの位置。閉じたときに Masonry が読み、読んだら捨てる
  const scrolled = useRef(0)
  const entryTop = useRef(0)
  const restoreTop = useRef<number | undefined>(undefined)
  useEffect(() => {
    restoreTop.current = undefined
  }, [listKey])
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
    // 計算が進むと「似た画像を探す」の基準にできるようになるので、読み直す
  }, [only, place, backfilled, features.done])

  // 拡大表示（FR-508）。左右キーか左右の端のボタンで、今の並び順の前後の画像に移る
  const zoomed = zoom ? selectedImage : null
  const at = zoomed ? order.indexOf(zoomed.id) : -1
  const moveTo = useCallback((id: number) => setSelection({ ids: new Set([id]), anchor: id }), [])
  const zoomView = useZoom(zoomed)
  const { changeView, zoomBy } = zoomView
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
    // 拡大表示の倍率（プレビューと同じキー）。JIS 配列の ⌘＋ は ; のキーで届く
    if (zoomed && e.metaKey && ['=', '+', ';', '-', '0', '9'].includes(e.key)) {
      e.preventDefault()
      if (e.key === '-') zoomBy(1 / ZOOM_STEP)
      else if (e.key === '0') changeView(actualSize)
      else if (e.key === '9') changeView(() => FIT)
      else zoomBy(ZOOM_STEP)
      return
    }
    const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (e.key === 'Escape') {
      if (zoomed) setZoom(false)
      else if (selection.ids.size) setSelection(EMPTY_SELECTION)
      else closeSimilar()
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
  useEffect(() => {
    const listener = (e: KeyboardEvent) => latest.current.onKey(e)
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

  // モデルがそろってから ON を保存する。失敗したら OFF のままにし、エラーと「再試行」を出す
  async function fetchModels() {
    setModelFetch({ running: true, progress: null, error: null })
    try {
      await invoke('prepare_models')
    } catch (e) {
      setModelFetch({ running: false, progress: null, error: String(e) })
      return
    }
    setModelFetch(null)
    // ダウンロードの間に変えたほかの設定を、始めたときの値で上書きしないよう、今の描画の関数を使う
    latest.current.changeSettings({ similarity_enabled: true })
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

  // 画像を選んでいても追加はせず、専用ウィンドウを開くだけにする（FR-701）
  function openBoard() {
    if (!settings.board_enabled) return
    invoke('show_board_window').catch((e) => setResult({ kind: 'error', message: String(e) }))
  }

  // 「ボードに追加」の追加先ダイアログに渡す画像（FR-701）。ゴミ箱と見つからない画像は追加できない
  const [adding, setAdding] = useState<number[] | null>(null)
  const canAdd = settings.board_enabled && !aside && ids.length > 0
  function addToBoard() {
    // メニューのショートカットはダイアログの間も届く。ほかのショートカットと同じく、ダイアログの間は効かせない
    if (!canAdd || document.querySelector('dialog[open]')) return
    setMenuAt(null)
    setAdding(ids)
  }
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
  // 最後に画像を追加したボード。右クリックの「「<ボード名>」に追加」の追加先（FR-712）
  const [lastBoard, setLastBoard] = useState<{ session: number; id: number; name: string } | null>(null)
  // 一覧と拡大表示で同じメニューを出す（FR-515）。拡大表示でも WebKit の標準のメニューは出さない
  async function openContextMenu(id: number, e: React.MouseEvent) {
    e.preventDefault()
    // 右クリックした画像を選んでいなければ、その画像だけを選ぶ（Finder と同じ）
    if (!selection.ids.has(id)) setSelection({ ids: new Set([id]), anchor: id })
    const at = { x: e.clientX, y: e.clientY }
    // 開いた後に項目が増えて押す位置がずれないよう、ボードを読んでから開く。名前の変更や削除は開くたびに読み直す
    let last = null
    if (settings.board_enabled && !aside) {
      try {
        const list = await invoke<Boards>('list_boards')
        const board = list.boards.find((b) => b.id === list.last_added_board_id)
        if (board) last = { session: list.session, id: board.id, name: board.name }
      } catch (err) {
        console.error(err)
      }
    }
    setLastBoard(last)
    setMenuAt(at)
  }
  // 開いているボードのウィンドウへ運ぶ（FR-713）。選んでいない画像をつかんだら、その画像だけを選んで運ぶ（Finder と同じ）
  function startDrag(id: number, e: React.DragEvent) {
    // ゴミ箱と見つからない画像はボードに置けないので、つかませない
    if (aside) return e.preventDefault()
    if (!settings.board_enabled) return
    const dragged = selection.ids.has(id) ? order.filter((i) => selection.ids.has(i)) : [id]
    if (!selection.ids.has(id)) setSelection({ ids: new Set([id]), anchor: id })
    e.dataTransfer.setData(IMAGE_DRAG, JSON.stringify(dragged))
    e.dataTransfer.effectAllowed = 'copy'
  }
  async function addToLastBoard() {
    if (!lastBoard || !canAdd) return
    try {
      await invoke('add_to_board', { session: lastBoard.session, target: { board: lastBoard.id }, images: ids })
    } catch (e) {
      setResult({ kind: 'error', message: `ボードに追加できません（${e}）` })
    }
  }
  // 「似た画像を探す」（FR-601）。結果の画像から押すと基準が入れ替わる。戻る履歴は作らない
  const canFindSimilar = settings.similarity_enabled && only !== null && !!shown?.detail?.similar
  async function findSimilar() {
    const image = selectedImage
    if (!image || !canFindSimilar || document.querySelector('dialog[open]')) return
    setMenuAt(null)
    let r: Similar
    try {
      r = await invoke<Similar>('similar_images', { id: image.id })
    } catch (e) {
      setResult({ kind: 'error', message: `似た画像を探せません（${e}）` })
      return
    }
    if (!similar) entryTop.current = scrolled.current
    setWeights(fillWeights(r.aspects, settings.similarity_weights))
    setSimilar({ ...r, base: image.id, image })
    setZoom(false)
  }
  function closeSimilar() {
    if (!similar) return
    restoreTop.current = entryTop.current
    setSimilar(null)
  }
  // 知らない観点（後の版で足した観点）の保存した値は残す
  const saveWeights = () => changeSettings({ similarity_weights: { ...settings.similarity_weights, ...weights } })
  // OFF にしたら結果のモードを閉じる
  if (similar && !settings.similarity_enabled) setSimilar(null)

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
    setSimilar(null)
    setAside(next)
    if (!next) setFilter(NO_FILTER)
    setSelection({ ids: new Set([id]), anchor: id })
    setRevealed({ id })
  }
  // リスナーは一度だけ登録する。呼ばれたときに今の描画の関数を使うよう、ref を通す
  const handlers = { scan, onKey, start, leave, openBoard, addToBoard, revealImage, changeSettings }
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    const unlisten = [
      // このウィンドウ宛てのイベントは、ウィンドウの listen で受ける
      getCurrentWindow().listen<number>('gallery-reveal', (e) => latest.current.revealImage(e.payload)),
      // 終わった後に届いた進み具合で、結果を戻さない
      getCurrentWindow().listen<BackfillCounts>('backfill-progress', (e) =>
        setBackfill((b) => (b?.running ? { ...b, counts: e.payload } : b)),
      ),
      getCurrentWindow().listen<FeaturesStatus>('features-progress', (e) => setFeatures(e.payload)),
      getCurrentWindow().listen<ImportProgress>('model-progress', (e) =>
        setModelFetch((m) => (m?.running ? { ...m, progress: e.payload } : m)),
      ),
      listen<ImportProgress>('import-progress', (e) => setProgress(e.payload)),
      // 終わった後に届いた進み具合で、表示を戻さない
      listen<ImportProgress>('scan-progress', (e) => setScanning((s) => s && e.payload)),
      listen('switch-library', () => latest.current.leave()),
      listen('open-board', () => latest.current.openBoard()),
      // 操作の対象は手前のウィンドウ。ボードのウィンドウが手前なら追加しない
      listen('add-to-board', () => document.hasFocus() && latest.current.addToBoard()),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'drop') latest.current.start(e.payload.paths)
      }),
    ]
    return () => unlisten.forEach((p) => p.then((f) => f()))
  }, [])

  async function pick(directory: boolean) {
    const title = directory ? '取り込むフォルダを選ぶ' : '取り込む画像を選ぶ'
    const paths = await open({ multiple: true, directory, title })
    if (paths) start(paths)
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
    lib.update((d) => removeImages(d, gone))
    setSelection((s) => ({ ids: new Set([...s.ids].filter((id) => !gone.has(id))), anchor: null }))
    setResult({ kind: 'trashed', count: r.done.length, failed: named(r.failed, data.images) })
    reloadTrash()
  }

  function openAside(next: 'trash' | 'missing') {
    setAside(next)
    setZoom(false)
    setSimilar(null)
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

  // タグ管理（FR-408）。変わるのはタグの行と画像のタグだけなので、一覧を読み直さずに手元の値を変える
  const [managingTags, setManagingTags] = useState(false)
  // from のタグを画像と絞り込みの条件から外す。into があれば代わりに付ける
  function forgetTag(from: number, into: number | null) {
    lib.update((d) => dropTag(d, from, into))
    setFilter((f) => ({ ...f, tags: swapTag(f.tags, from, into) }))
  }
  async function mergeTag(from: number, into: number) {
    await invoke('merge_tag', { from, into })
    forgetTag(from, into)
  }
  async function deleteTag(id: number) {
    await invoke('delete_tag', { id })
    forgetTag(id, null)
  }

  const reveal = (id?: number) =>
    invoke('show_in_finder', { id }).catch((e) => setResult({ kind: 'error', message: `Finder で開けません（${e}）` }))

  // 確認ダイアログで答えを待っている、元に戻せない操作。パネルのボタンと右クリックのどちらからも出す
  const [asking, setAsking] = useState<'purge' | 'empty' | 'forget' | null>(null)
  const askedName = selected.length === 1 ? `「${selected[0].file_name}」` : `選んだ画像 ${ids.length}枚`
  const menu = imageMenu(aside ?? 'gallery', {
    count: ids.length,
    board: settings.board_enabled,
    lastBoard: !!lastBoard,
    similarity: settings.similarity_enabled,
  })
  function runMenu(action: ImageAction) {
    setMenuAt(null)
    if (action === 'similar') findSimilar()
    else if (action === 'board') addToBoard()
    else if (action === 'lastBoard') addToLastBoard()
    else if (action === 'reveal') reveal(ids[0])
    else if (action === 'trash') trashImages(ids)
    else if (action === 'restore') restoreImages()
    else setAsking(action)
  }

  const title = similar
    ? '似た画像'
    : inTrash
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
        'gallery' +
        (similar ? ' gallery--similar' : '') +
        (detailOpen ? '' : ' gallery--no-detail') +
        (detailMotion ? ` gallery--detail-${detailMotion}` : '')
      }
      onAnimationEnd={(e) => {
        if (e.animationName === 'detail-out') setDetailOpen(false)
        if (e.animationName === 'detail-in' || e.animationName === 'detail-out') setDetailMotion(null)
      }}
    >
      <GalleryHeader
        root={root}
        recent={recent}
        filter={filter}
        categories={data.categories}
        tags={data.tags}
        onFilter={changeFilter}
        busy={scanning ? 'scan' : progress ? 'import' : null}
        onPick={pick}
        onOpenBoard={settings.board_enabled ? openBoard : undefined}
        onSettings={() => setSettingsOpen(true)}
        onLeave={leave}
      />

      <Sidebar
        gallery={data}
        filter={filter}
        counts={counts}
        onFilter={changeFilter}
        onManageTags={() => setManagingTags(true)}
        onRename={lib.renameCategory}
        onCreate={lib.createCategory}
        onMove={lib.moveCategory}
        onDelete={lib.deleteCategory}
        onCollapse={lib.collapseCategories}
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
        categoryChildren={settings.category_children}
        onCategoryChildren={(category_children) => changeSettings({ category_children })}
      />

      <GalleryToolbar
        title={title}
        count={listed.length}
        sort={aside || similar ? undefined : sort}
        onSort={setSort}
        lead={
          similar && (
            <img
              className="toolbar__base"
              src={convertFileSrc(`${root}/.kura/thumbs/${similar.image.hash}.jpg`)}
              alt={`基準の画像 ${similar.image.file_name}`}
              style={{
                aspectRatio: `${similar.image.width} / ${similar.image.height}`,
                background: similar.image.color,
              }}
            />
          )
        }
        note={similar?.uncomputed ? `未計算 ${similar.uncomputed}枚` : undefined}
        detailShown={detailShown}
        onToggleDetail={() => toggleDetail()}
      >
        {/* 拡大表示の間は、サムネイルの大きさの代わりに画像の倍率を出す。後ろに隠れたサムネイルを変えても見えないため */}
        {zoomed && zoomView.frame ? (
          <ZoomSlider zoom={zoomView} image={zoomed} frame={zoomView.frame} />
        ) : (
          !zoomed && <ThumbSlider width={thumbWidth} onChange={(thumb_width) => changeSettings({ thumb_width })} />
        )}
        {similar && (
          <button type="button" className="button" title="閉じる（esc）" onClick={closeSimilar}>
            <Icon d={ICONS.x} />
            閉じる
          </button>
        )}
      </GalleryToolbar>
      {similar && (
        <WeightSliders
          aspects={similar.aspects}
          skipped={similar.skipped}
          weights={weights}
          onChange={(a, v) => setWeights((w) => changeWeight(w, a, v))}
          onCommit={saveWeights}
        />
      )}

      <Masonry
        root={root}
        images={listed}
        scrollKey={listKey}
        scrollTo={restoreTop.current}
        onScrolled={(top) => (scrolled.current = top)}
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
        onDragStart={startDrag}
        active={selection.anchor}
        reveal={revealed}
        keys={!zoomed}
        onMove={moveTo}
      />

      {zoomed && (
        <ZoomPanel
          zoom={zoomView}
          image={zoomed}
          // 元の画像のパスがわかるまではサムネイルを出す
          src={convertFileSrc(shown?.detail?.path ?? `${root}/.kura/thumbs/${zoomed.hash}.jpg`)}
          onPrev={at > 0 ? () => step(-1) : undefined}
          onNext={at < order.length - 1 ? () => step(1) : undefined}
          onClose={() => setZoom(false)}
          onContextMenu={(e) => openContextMenu(zoomed.id, e)}
        />
      )}

      {/* 閉じる動きの間は、フォーカスもクリックも受けない */}
      <div className="gallery__detail-slot" inert={detailMotion === 'closing'}>
        {!detailOpen ? null : inTrash ? (
          <TrashPanel
            count={trash.length}
            selected={ids.length}
            name={selected.length === 1 ? selected[0].file_name : undefined}
            onRestore={restoreImages}
            onPurge={() => setAsking('purge')}
            onEmpty={() => setAsking('empty')}
          />
        ) : inMissing ? (
          <MissingPanel
            selected={ids.length}
            name={selected.length === 1 ? selected[0].file_name : undefined}
            onForget={() => setAsking('forget')}
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
            onRate={lib.rate}
            onAssign={lib.assign}
            onRename={lib.renameImage}
            onTagCreated={(tag) => lib.update((d) => addTag(d, tag))}
            recentTags={recentTags}
            onTagged={(tag, ids) => {
              setRecentTags((r) => rememberTag(r, tag))
              lib.update((d) =>
                editImages(d, ids, (i) => (i.tags.includes(tag) ? i : { ...i, tags: [...i.tags, tag] })),
              )
            }}
            onUntagged={(tag, ids) =>
              lib.update((d) => editImages(d, ids, (i) => ({ ...i, tags: i.tags.filter((t) => t !== tag) })))
            }
            onMemo={(id, memo) => lib.update((d) => editImages(d, [id], (i) => ({ ...i, memo })))}
            onTrash={trashImages}
            onReveal={reveal}
            // ゴミ箱と見つからない画像を開いている間は、この詳細パネルを出さない
            onOpen={() => setZoom(true)}
            onAddToBoard={settings.board_enabled ? addToBoard : undefined}
            onFindSimilar={settings.similarity_enabled ? findSimilar : undefined}
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
                ? `${images.length} / ${whole.length}枚`
                : `${whole.length}枚`}
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
        <FeaturesProgress status={features} />
      </footer>

      {menuAt && (
        <div ref={contextMenu} className="menu" role="menu" popover="manual" style={{ top: menuAt.y, left: menuAt.x }}>
          {menu.map((action, i) =>
            action === 'rule' ? (
              <hr key={i} className="menu__rule" />
            ) : (
              <button
                key={action}
                type="button"
                role="menuitem"
                className="menu__item"
                disabled={action === 'similar' && !canFindSimilar}
                title={
                  action === 'similar' && ids.length === 1 && shown?.detail && !canFindSimilar
                    ? NOT_COMPUTED
                    : undefined
                }
                onClick={() => runMenu(action)}
              >
                {action === 'lastBoard' ? `「${lastBoard?.name}」に追加` : ACTION_LABELS[action]}
              </button>
            ),
          )}
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title={
            asking === 'purge'
              ? '選んだ画像を完全に削除する'
              : asking === 'empty'
                ? 'ゴミ箱を空にする'
                : '選んだ画像を一覧から外す'
          }
          confirm={asking === 'purge' ? '削除する' : asking === 'empty' ? '空にする' : '外す'}
          onConfirm={() => {
            setAsking(null)
            if (asking === 'purge') purge(ids)
            else if (asking === 'empty') purge()
            else forget()
          }}
          onClose={() => setAsking(null)}
        >
          {asking === 'forget'
            ? `${askedName}のタグ、メモ、評価を削除します。元に戻せません。`
            : `${asking === 'purge' ? askedName : `ゴミ箱の画像 ${trash.length}枚`}を完全に削除します。元に戻せません。`}
        </ConfirmDialog>
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
          modelFetch={modelFetch}
          features={features}
          onFetchModels={fetchModels}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {managingTags && (
        <TagDialog
          tags={data.tags}
          counts={counts.tags}
          onRename={lib.renameTag}
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
