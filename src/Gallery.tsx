import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open } from '@tauri-apps/plugin-dialog'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { recentLimit, rememberTag } from './choices'
import ConfirmDialog from './ConfirmDialog'
import { ACTION_LABELS, type ImageAction, imageMenu, parentMoves, useContextMenu } from './contextMenu'
import CategoryDialog from './CategoryDialog'
import MergeDialog from './MergeDialog'
import { flushAll } from './flush'
import { Icon, ICONS } from './icons'
import GalleryHeader, { SEARCH_BY_IMAGE } from './GalleryHeader'
import GalleryToolbar, { THUMB_MAX, THUMB_MIN, ThumbSlider, WeightSliders } from './GalleryToolbar'
import { addTag, dropTag, editImages, hideMarked, named, removeImages, swapTag } from './galleryData'
import Detail, { NOT_COMPUTED } from './Detail'
import { countImages, type Filter, filterImages, NO_FILTER } from './filter'
import MoveFailDialog from './MoveFailDialog'
import Masonry from './Masonry'
import SettingsPage, { type SettingsKind } from './SettingsPage'
import Sidebar from './Sidebar'
import NameDialog from './NameDialog'
import { readSmartFolder, type SmartFolder, writeSmartFolder } from './smartFolder'
import SkipDialog from './SkipDialog'
import TidyDialog from './TidyDialog'
import Status from './Status'
import StatusbarResult, { FeaturesProgress, OriginProgress, type Result } from './StatusbarResult'
import MissingPanel from './MissingPanel'
import TrashPanel from './TrashPanel'
import type { Boards } from './board/types'
import type { Detail as DetailData, Done, Image, Merged, Restored, Settings } from './galleryTypes'
import type {
  Backfill,
  BackfillCounts,
  FeaturesStatus,
  ImportProgress,
  ModelFetch,
  Report,
  ScanReport,
  Skipped,
} from './importTypes'
import { showGroups } from './origin'
import { EMPTY_SELECTION, keepOnly, select } from './selection'
import { changeWeight, fillWeights, rankSimilar, type Similar, type Weights } from './similarity'
import { type SortKey, sortImages } from './sort'
import { useLibrary } from './useLibrary'
import type { PoseOf } from './pose'
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
  // Rust が開き直した同じライブラリで、画面を作り直す（FR-107）
  onReopen: () => void
}

const FEATURES_IDLE: FeaturesStatus = { running: false, done: 0, total: 0, failed: 0, error: null }

export default function Gallery({ root, recent, settings, onSettings, onSwitch, onReopen }: Props) {
  const [sort, setSort] = useState<SortKey>('imported')
  // 詳細パネルの最近使ったタグ。起動の間だけ覚える（ライブラリを開き直すと Gallery ごと作り直すので空に戻る）
  const [recentTags, setRecentTags] = useState<number[]>([])
  const [filter, setFilter] = useState(NO_FILTER)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const lib = useLibrary(setResult)
  const { loadError, reload, reloadTrash, reloadMissing } = lib
  // 隠すモード（FR-513）の間は、隠す印の付いた画像が手元の一覧にないものとして扱う。
  // 一覧から選べないので、詳細パネルと拡大表示にも出ない
  const hiding = settings.hide_mode
  const data = useMemo(() => ({ ...lib.data, images: hideMarked(lib.data.images, hiding) }), [lib.data, hiding])
  const trash = useMemo(() => hideMarked(lib.trash, hiding), [lib.trash, hiding])
  const missing = useMemo(() => hideMarked(lib.missing, hiding), [lib.missing, hiding])
  // 件数に含めない代わりに、ステータスバーに出す。一覧、ゴミ箱、見つからない画像の合計
  const hiddenCount =
    lib.data.images.length - data.images.length + lib.trash.length - trash.length + lib.missing.length - missing.length
  const [showSkipped, setShowSkipped] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  // スキップの一覧の重複の行の「整理…」（FR-109）で開いた行
  const [tidying, setTidying] = useState<(Skipped & { kind: 'duplicate' }) | null>(null)
  const [selection, setSelection] = useState(EMPTY_SELECTION)
  const [zoom, setZoom] = useState(false)
  // 設定で出している種類。null は設定を閉じている（8章）
  const [settingsKind, setSettingsKind] = useState<SettingsKind | null>(null)
  const settingsOpen = settingsKind !== null
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
  // 元が同じ画像の組を探している間の進み具合（FR-611）。null は探していない
  const [originSearch, setOriginSearch] = useState<ImportProgress | null>(null)
  // 見つけた組（FR-611）。保存せず、外した組と1枚にまとめた組は取り除く。null は結果のモードでない
  const [groups, setGroups] = useState<number[][] | null>(null)
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

  // 類似画像検索の結果のモード（FR-601）。押したときの1回分を持ち、計算が進んでも読み直さない。
  // base が null なら、ライブラリの外の画像で探した（FR-608）。lead は帯に出す基準画像のサムネイル
  const [similar, setSimilar] = useState<(Similar & { base: number | null; lead: Lead }) | null>(null)
  // ライブラリの外の画像のサムネイルは Blob の URL で持つので、結果を閉じたり入れ替えたりしたら捨てる
  const leadSrc = similar?.lead.src
  useEffect(() => () => void (leadSrc?.startsWith('blob:') && URL.revokeObjectURL(leadSrc)), [leadSrc])
  // 重み（FR-602）。動かしている間はここだけを変え、手を離したら設定に保存する
  const [weights, setWeights] = useState<Weights>({})
  // スライダーの動きを、2万枚の並べ直しで待たせない
  const ranking = useDeferredValue(weights)
  const rankedIds = useMemo(() => similar && rankSimilar(similar, ranking), [similar, ranking])
  const byId = useMemo(() => new Map(data.images.map((i) => [i.id, i])), [data.images])
  // ゴミ箱へ移した画像などは手元の一覧から消えているので、結果からも外す
  const ranked = useMemo(() => rankedIds?.flatMap((id) => byId.get(id) ?? []), [rankedIds, byId])

  const sorted = useMemo(() => sortImages(data.images, sort), [data.images, sort])
  // 結果のモードでも、サイドバーのカテゴリ・タグと検索バーで絞り込む（FR-603）。
  // 元が同じ画像の組は、条件に合う画像を1枚でも含む組を組ごと出す（FR-611）
  const matched = useMemo(
    () => filterImages(ranked ?? sorted, data.categories, data.tags, filter, settings.category_children),
    [ranked, sorted, data.categories, data.tags, filter, settings.category_children],
  )
  const allGroups = useMemo(() => groups && showGroups(groups, byId, null), [groups, byId])
  const shownGroups = useMemo(
    () => groups && showGroups(groups, byId, new Set(matched.map((i) => i.id))),
    [groups, byId, matched],
  )
  const images = useMemo(() => shownGroups?.flat() ?? matched, [shownGroups, matched])
  const counts = useMemo(
    () => countImages(data.images, data.categories, settings.category_children),
    [data.images, data.categories, settings.category_children],
  )
  // 全体の枚数。結果のモードでは、結果の枚数（特徴量のある画像、組の画像）
  const whole = useMemo(() => allGroups?.flat() ?? ranked ?? data.images, [allGroups, ranked, data.images])
  const filtered = images.length !== whole.length

  // 絞り込みで見えなくなった画像の選択は、下の effect が外す。見えない画像までまとめて変えないため
  function changeFilter(next: Filter) {
    setFilter(next)
    // サイドバーで絞り込んだら、設定のページを閉じて結果を見せる
    setSettingsKind(null)
    if (aside) {
      setAside(null)
      setSelection(EMPTY_SELECTION)
    }
  }

  // スマートフォルダ（FR-510）。opened は開いたときの条件で、今の絞り込みと並べ替えが同じ間だけ選んだ見た目にする
  const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([])
  const [opened, setOpened] = useState<{ id: number; saved: string } | null>(null)
  const [savingSmart, setSavingSmart] = useState(false)
  const currentSmart = writeSmartFolder({ filter, sort, children: settings.category_children })
  const openedSmart = (opened?.saved === currentSmart && smartFolders.find((f) => f.id === opened.id)) || null
  useEffect(() => {
    invoke<SmartFolder[]>('list_smart_folders')
      .then(setSmartFolders)
      .catch((e) => setResult({ kind: 'error', message: `スマートフォルダを読めません（${e}）` }))
  }, [])
  const reloadSmart = async () => setSmartFolders(await invoke<SmartFolder[]>('list_smart_folders'))
  function openSmart(folder: SmartFolder) {
    const { saved, dropped } = readSmartFolder(folder.filter, data.categories, data.tags)
    changeFilter(saved.filter)
    setSort(saved.sort)
    if (saved.children !== settings.category_children) changeSettings({ category_children: saved.children })
    setOpened({ id: folder.id, saved: writeSmartFolder(saved) })
    // 保存した条件は書き換えない。開くたびに外して知らせる
    if (dropped)
      setResult({
        kind: 'info',
        message: `「${folder.name}」の条件から、なくなったタグとカテゴリ ${dropped}件を外しました`,
      })
  }
  // 絞り込みも並べ替えも初期のままなら保存するものがない
  const canSaveSmart =
    currentSmart !== writeSmartFolder({ filter: NO_FILTER, sort: 'imported', children: settings.category_children })

  // ゴミ箱と見つからない画像は新しい順に出し、並べ替えと絞り込みはしない
  const listed = inTrash ? trash : inMissing ? missing : images
  // 一覧のスクロールを先頭に戻す契機。画像の中身（タグ・メモなど）の変化では戻さない
  // 組を外したりまとめたりしても戻さない
  const listKey = JSON.stringify([sort, filter, aside, similar?.lead.src ?? null, groups !== null])
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
  // 骨格の重ね表示（FR-606）。初期値は OFF で、状態は保存しない
  const [poseOn, setPoseOn] = useState(false)
  const [pose, setPose] = useState<{ id: number; people: number[][] } | null>(null)
  const zoomedId = zoomed?.id ?? null
  useEffect(() => {
    if (zoomedId === null || !settings.similarity_enabled) return
    let current = true
    invoke<PoseOf>('image_pose', { id: zoomedId }).then(
      (p) => current && setPose({ id: zoomedId, people: p.people }),
      // 読めなければ、ポーズのない画像と同じく切り替えを出さない。理由は Rust がログに残す
      () => current && setPose({ id: zoomedId, people: [] }),
    )
    return () => {
      current = false
    }
    // 計算が進むとポーズが入るので、読み直す
  }, [zoomedId, settings.similarity_enabled, features.done])
  const people = settings.similarity_enabled && pose && pose.id === zoomedId ? pose.people : []
  const step = (by: number) => {
    const id = order[at + by]
    if (id !== undefined) moveTo(id)
  }

  // キーボードの操作（FR-508、FR-509、NFR-12）。一覧の矢印キーは Masonry で受ける
  const onKey = (e: KeyboardEvent) => {
    // ダイアログの中の操作は奪わない
    if ((e.target as Element).closest('dialog')) return
    const key = e.key.toLowerCase()
    // ⇧⌘F はメニューの「似た画像を探す」。ここで止めるとメニューに届かない
    if (e.metaKey && !e.shiftKey && key === 'f') {
      e.preventDefault()
      document.getElementById('search')?.focus()
      return
    }
    if (e.metaKey && key === ',') {
      e.preventDefault()
      setSettingsKind((k) => k ?? 'general')
      return
    }
    // 設定のページの間は、下の一覧に効くキーを受けない。Escape で一覧に戻る
    if (settingsOpen) {
      if (e.key === 'Escape') setSettingsKind(null)
      // ページの文字をすべて選ばせない。検索欄など入力欄の中の ⌘A は、文字の全選択のまま残す
      else if (e.metaKey && key === 'a' && !(e.target as Element).closest('input, textarea, select')) e.preventDefault()
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
      else if (groups) closeGroups()
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
  // 管理情報を戻す（FR-107）。ライブラリの切り替えと同じく、取り込みと差分検出の間は断り、メモとボードを
  // 保存してボードを閉じてから戻す。失敗は理由の文字列で reject し、設定のページに出す
  async function restoreLibrary(path: string) {
    if (busy.current) throw '取り込みか Finder での変更の反映が終わってから、もう一度選んでください'
    try {
      await flushAll()
    } catch {
      throw 'メモを保存できないため、管理情報をインポートできません'
    }
    try {
      await invoke('close_board_window')
    } catch (e) {
      throw `ボードを保存できないため、管理情報をインポートできません（${e}）`
    }
    await invoke('restore_library', { path })
    // 開き直した画面が一覧を読み、差分検出で書き出した後のファイルの変化を反映する
    onReopen()
  }

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
  // 設定のページの間は、下に隠れた選択をボードへ送らない
  const canAdd = settings.board_enabled && !aside && !settingsOpen && ids.length > 0
  function addToBoard() {
    // メニューのショートカットはダイアログの間も届く。ほかのショートカットと同じく、ダイアログの間は効かせない
    if (!canAdd || document.querySelector('dialog[open]')) return
    setMenuAt(null)
    setAdding(ids)
  }
  // Rust に知らせ、メニューの「ボードに追加…」の有効・無効と、ダイアログの間にボードの最前面の固定を
  // 外すのに使う。固定したボードの後ろにダイアログが隠れないように（FR-701、FR-705）
  // 押せる条件は詳細パネルのボタンと同じ。メニューの「似た画像を探す」の有効・無効にも使う（6章）
  const canFindSimilar = settings.similarity_enabled && only !== null && !!shown?.detail?.similar
  const dialogOpen = useDialogOpen()
  useEffect(() => {
    invoke('report_gallery', { addable: canAdd, similar: canFindSimilar, dialog: dialogOpen }).catch((e) =>
      console.error(e),
    )
  }, [canAdd, canFindSimilar, dialogOpen])
  useEffect(
    () => () => {
      invoke('report_gallery', { addable: false, similar: false, dialog: false }).catch((e) => console.error(e))
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
    if (!similar && !groups) entryTop.current = scrolled.current
    setWeights(fillWeights(r.aspects, settings.similarity_weights))
    setSimilar({
      ...r,
      base: image.id,
      lead: {
        src: convertFileSrc(`${root}/.kura/thumbs/${image.hash}.jpg`),
        name: image.file_name,
        ratio: `${image.width} / ${image.height}`,
        color: image.color,
      },
    })
    // 組の結果は保存しないので、似た画像の結果に入れ替える
    setGroups(null)
    setZoom(false)
  }
  // 「画像で探す」（FR-608）。ライブラリの外の画像1枚を基準に探す。画像は取り込まない
  const [searchingFile, setSearchingFile] = useState(false)
  async function searchByImage(paths: string[]) {
    if (searchingFile || !settings.similarity_enabled) return
    if (paths.length !== 1) {
      setResult({
        kind: 'error',
        message: paths.length ? '画像で探せるのは1枚だけです' : '画像のファイルではないので探せません',
      })
      return
    }
    setSearchingFile(true)
    let r: Similar & { thumb: number[] }
    try {
      r = await invoke<Similar & { thumb: number[] }>('similar_to_file', { path: paths[0] })
    } catch (e) {
      setResult({ kind: 'error', message: `画像で探せません（${e}）` })
      return
    } finally {
      setSearchingFile(false)
    }
    const { thumb, ...found } = r
    if (!similar && !groups && !aside) entryTop.current = scrolled.current
    setWeights(fillWeights(found.aspects, settings.similarity_weights))
    setSimilar({
      ...found,
      base: null,
      lead: {
        src: URL.createObjectURL(new Blob([new Uint8Array(thumb)], { type: 'image/jpeg' })),
        name: paths[0].split('/').pop()!,
      },
    })
    setGroups(null)
    setSettingsKind(null)
    setAside(null)
    setZoom(false)
    setSelection(EMPTY_SELECTION)
  }
  async function pickSearchImage() {
    const path = await open({
      title: '似た画像を探す画像を選ぶ',
      filters: [{ name: '画像', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    })
    if (path) searchByImage([path])
  }
  // ファイルをドラッグしている間の「画像で探す」の状態。null はドラッグしていない（FR-608）
  const [fileDrag, setFileDrag] = useState<'outside' | 'over' | null>(null)
  function closeSimilar() {
    if (!similar) return
    restoreTop.current = entryTop.current
    setSimilar(null)
  }
  // メニューの「似た画像を探す」（⇧⌘F）。入力欄の中では効かせない。ダイアログの間は findSimilar が止める（6章）
  function findSimilarFromMenu() {
    if (!document.hasFocus() || document.activeElement?.closest('input, textarea, select')) return
    findSimilar()
  }
  // 元が同じ画像の組を探す（FR-611）。探している間もほかの操作を続けられる。中止したら結果を出さない
  async function findGroups() {
    if (!settings.similarity_enabled || originSearch || document.querySelector('dialog[open]')) return
    setSettingsKind(null)
    setOriginSearch({ done: 0, total: 0 })
    let found: number[][] | null
    try {
      found = await invoke<number[][] | null>('find_origin_groups')
    } catch (e) {
      setResult({ kind: 'error', message: `元が同じ画像の組を探せません（${e}）` })
      found = null
    }
    setOriginSearch(null)
    if (!found) return
    if (!similar && !groups && !aside) entryTop.current = scrolled.current
    setGroups(found)
    setSimilar(null)
    setAside(null)
    setZoom(false)
    setSelection(EMPTY_SELECTION)
  }
  function closeGroups() {
    restoreTop.current = entryTop.current
    setGroups(null)
  }
  // 知らない観点（後の版で足した観点）の保存した値は残す
  const saveWeights = () => changeSettings({ similarity_weights: { ...settings.similarity_weights, ...weights } })
  // OFF にしたら結果のモードを閉じる
  if (similar && !settings.similarity_enabled) setSimilar(null)
  if (groups && !settings.similarity_enabled) setGroups(null)
  // 帯に出す基準画像のサムネイルも隠すモードでは出さない（FR-513）。結果を閉じる
  if (hiding && similar && similar.base !== null && lib.data.images.some((i) => i.id === similar.base && i.hidden))
    setSimilar(null)

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
    setGroups(null)
    setAside(next)
    if (!next) setFilter(NO_FILTER)
    setSelection({ ids: new Set([id]), anchor: id })
    setRevealed({ id })
  }
  // リスナーは一度だけ登録する。呼ばれたときに今の描画の関数を使うよう、ref を通す
  const handlers = {
    scan,
    onKey,
    start,
    leave,
    openBoard,
    addToBoard,
    revealImage,
    changeSettings,
    findSimilarFromMenu,
    findGroups,
    searchByImage,
  }
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
      listen('find-similar', () => latest.current.findSimilarFromMenu()),
      listen('find-origin-groups', () => latest.current.findGroups()),
      // 終わった後に届いた進み具合で、表示を戻さない
      getCurrentWindow().listen<ImportProgress>('origin-progress', (e) => setOriginSearch((s) => s && e.payload)),
      // 「画像で探す」に落としたら探し、ほかの場所に落としたら取り込む（FR-608）
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload
        if (p.type === 'leave') return setFileDrag(null)
        if (p.type === 'enter') measureTitleBar()
        const over = onSearchByImage(p.position)
        if (p.type === 'drop') {
          setFileDrag(null)
          if (over) latest.current.searchByImage(p.paths)
          else latest.current.start(p.paths)
        } else if (p.type === 'over') setFileDrag((d) => d && (over ? 'over' : 'outside'))
        // ページの中の画像のドラッグ（ボードへの追加）は paths が空なので、落とし先として目立たせない
        else if (p.paths.length) setFileDrag(over ? 'over' : 'outside')
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

  // 「1枚にまとめる…」（FR-610）。類似画像検索の結果のモードで2枚以上を選んだときだけ。開いたときの画像を持つ
  const [merging, setMerging] = useState<Image[] | null>(null)
  const canMerge = !!similar && !aside && selected.length >= 2
  // 失敗したら reject してダイアログに理由を出す。途中まで進んだかもしれないので、どちらでも一覧を読み直す。
  // ゴミ箱へ移した画像は手元の一覧から消えるので、結果のモードの一覧からも外れる
  async function mergeImages(keep: number, category: number | null, tags: number[]) {
    const remove = merging!.filter((i) => i.id !== keep).map((i) => i.id)
    let r: Merged
    try {
      r = await invoke<Merged>('merge_images', { keep, remove, category, tags })
    } finally {
      reload()
      reloadTrash()
    }
    setSelection({ ids: new Set([keep]), anchor: keep })
    setResult({ kind: 'merged', count: r.trashed.length, failed: named(r.failed, data.images) })
  }

  function openAside(next: 'trash' | 'missing') {
    setSettingsKind(null)
    setAside(next)
    setZoom(false)
    setSimilar(null)
    setGroups(null)
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
    setResult({ kind: 'emptied', count: r.done.length, failed: named(r.failed, lib.trash) })
    reloadTrash()
  }

  // タグ管理（FR-408）。変わるのはタグの行と画像のタグだけなので、一覧を読み直さずに手元の値を変える
  // from のタグを画像と絞り込みの条件から外す。into があれば代わりに付ける
  function forgetTag(from: number, into: number | null) {
    lib.update((d) => dropTag(d, from, into))
    setFilter((f) => {
      const tags = swapTag(f.tags, from, into)
      // 統合先を選んでいれば、除くからは外す。選ぶと除くは重ならない
      return { ...f, tags, excludeTags: swapTag(f.excludeTags, from, into).filter((t) => !tags.includes(t)) }
    })
  }
  async function mergeTag(from: number, into: number) {
    await invoke('merge_tag', { from, into })
    forgetTag(from, into)
  }
  async function deleteTag(id: number) {
    await invoke('delete_tag', { id })
    forgetTag(id, null)
  }

  // 隠す印を付け外しする（FR-513）。隠すモードの間に付けた画像は一覧から消え、選択も外れる
  async function mark(targets: number[], hidden: boolean) {
    try {
      await invoke('set_hidden', { ids: targets, hidden })
    } catch (e) {
      setResult({ kind: 'error', message: `隠す印を${hidden ? '付けられ' : '外せ'}ません（${e}）` })
      return
    }
    lib.update((d) => editImages(d, targets, (i) => ({ ...i, hidden })))
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
    merge: canMerge,
    unmarked: selected.some((i) => !i.hidden),
    marked: selected.some((i) => i.hidden),
  })
  // 右クリックからのカテゴリの変更（FR-416）。1つ上がない画像を含むと null
  // 開いたときの画像を持つ。移した画像が絞り込みから外れて選択が空になっても、閉じるまでダイアログを描けるように
  const [changingCategory, setChangingCategory] = useState<Image[] | null>(null)
  const up = parentMoves(selected, data.categories)
  async function moveUp() {
    if (!up) return
    try {
      await lib.assignEach(up)
    } catch (e) {
      setResult({ kind: 'error', message: `カテゴリを変えられません（${e}）` })
    }
  }
  function runMenu(action: ImageAction) {
    setMenuAt(null)
    if (action === 'similar') findSimilar()
    else if (action === 'category') setChangingCategory(selected)
    else if (action === 'parent') moveUp()
    else if (action === 'board') addToBoard()
    else if (action === 'lastBoard') addToLastBoard()
    else if (action === 'reveal') reveal(ids[0])
    else if (action === 'hide') mark(ids, true)
    else if (action === 'unhide') mark(ids, false)
    else if (action === 'merge') setMerging(selected)
    else if (action === 'trash') trashImages(ids)
    else if (action === 'restore') restoreImages()
    else setAsking(action)
  }

  const title = similar
    ? '似た画像'
    : groups
      ? '元が同じ画像'
      : inTrash
        ? 'ゴミ箱'
        : inMissing
          ? '見つからない'
          : openedSmart
            ? openedSmart.name
            : filter.category === 'all'
              ? 'すべての画像'
              : filter.category === 'uncategorized'
                ? '未分類'
                : (data.categories.find((c) => c.id === filter.category)?.name ?? '')

  const skipped = result?.kind === 'report' || result?.kind === 'scan' ? result.report.skipped : []

  // 差分検出のスキップの一覧の行を差し替える。一覧は保存しないので、ステータスバーの結果が持つ
  const editSkipped = (edit: (list: Skipped[]) => Skipped[]) =>
    setResult((r) => (r?.kind === 'scan' ? { ...r, report: { ...r.report, skipped: edit(r.report.skipped) } } : r))
  // 対応していない形式のファイルを _未対応ファイル/ へ移す（FR-108）。移した行と移せなかった行を差し替える
  async function setAsideFiles(paths: string[]) {
    let next: Skipped[]
    try {
      next = await invoke<Skipped[]>('set_aside_unsupported', { paths })
    } catch (e) {
      next = paths.map((path) => ({ path, kind: 'error', message: String(e) }))
    }
    const byPath = new Map(next.map((s) => [s.path, s]))
    editSkipped((list) => list.map((s) => byPath.get(s.path) ?? s))
  }
  // 重複を整理する（FR-109）。失敗したら reject してダイアログに理由を出す。登録済みの画像を移したかもしれないので、どちらでも読み直す
  async function tidy(keepRegistered: boolean) {
    const s = tidying!
    try {
      await invoke('tidy_duplicate', { path: s.path, existing: s.existing, keepRegistered })
    } finally {
      reload()
    }
    editSkipped((list) => list.filter((x) => x.path !== s.path))
  }
  // 組ごとの見出しの行（FR-611）。「1枚にまとめる…」は組の全部の画像でダイアログを開く
  const sections = useMemo(() => {
    let start = 0
    return shownGroups?.map((g) => {
      const section = {
        start,
        header: (
          <>
            <span className="list__section-count">{g.length}枚</span>
            <button type="button" className="button" onClick={() => setMerging(g)}>
              1枚にまとめる…
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setGroups((all) => all && all.filter((ids) => !g.some((i) => ids.includes(i.id))))}
            >
              一覧から外す
            </button>
          </>
        ),
      }
      start += g.length
      return section
    })
  }, [shownGroups])
  const tidyExisting = tidying && data.images.find((i) => i.id === tidying.existing)

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
        searchByImage={
          settings.similarity_enabled
            ? { onPick: pickSearchImage, drag: fileDrag, searching: searchingFile }
            : undefined
        }
        onOpenBoard={settings.board_enabled ? openBoard : undefined}
        settingsOpen={settingsOpen}
        onSettings={() => setSettingsKind((k) => (k ? null : 'general'))}
        onLeave={leave}
      />

      {/* 設定の間は、下に残したサイドバー・帯・一覧・詳細パネルを操作させない（display: contents の入れ物）。
          サイドバーを外さず残すのは、閉じたときにタグの検索の文字や開閉を戻すため */}
      <div className="gallery__main" inert={settingsOpen}>
        <Sidebar
          gallery={data}
          filter={filter}
          counts={counts}
          onFilter={changeFilter}
          onManageTags={() => setSettingsKind('tags')}
          onRename={lib.renameCategory}
          onTagReading={lib.setTagReading}
          onCreate={async (parent, name) => void (await lib.createCategory(parent, name))}
          onMove={lib.moveCategory}
          onDelete={lib.deleteCategory}
          onMerge={lib.mergeCategory}
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
          smartFolders={smartFolders}
          openedSmart={openedSmart?.id ?? null}
          onOpenSmart={openSmart}
          onRenameSmart={async (id, name) => {
            await invoke('rename_smart_folder', { id, name })
            await reloadSmart()
          }}
          onDeleteSmart={(id) =>
            invoke('delete_smart_folder', { id })
              .then(reloadSmart)
              .catch((e) => setResult({ kind: 'error', message: `スマートフォルダを削除できません（${e}）` }))
          }
        />
        <GalleryToolbar
          title={title}
          count={shownGroups?.length ?? listed.length}
          unit={shownGroups ? '組' : '枚'}
          sort={aside || similar || groups ? undefined : sort}
          onSort={setSort}
          onSaveSmart={!aside && !similar && !groups && canSaveSmart ? () => setSavingSmart(true) : undefined}
          lead={
            similar && (
              <img
                className="toolbar__base"
                src={similar.lead.src}
                alt={`基準の画像 ${similar.lead.name}`}
                style={{ aspectRatio: similar.lead.ratio, background: similar.lead.color }}
              />
            )
          }
          note={similar?.uncomputed ? `未計算 ${similar.uncomputed}枚` : undefined}
          detailShown={detailShown}
          onToggleDetail={() => toggleDetail()}
        >
          {/* 拡大表示の間は、サムネイルの大きさの代わりに画像の倍率を出す。後ろに隠れたサムネイルを変えても見えないため */}
          {zoomed && zoomView.frame ? (
            <>
              {people.length > 0 && (
                <button type="button" className="button" aria-pressed={poseOn} onClick={() => setPoseOn((on) => !on)}>
                  骨格を重ねる
                </button>
              )}
              <ZoomSlider zoom={zoomView} image={zoomed} frame={zoomView.frame} />
            </>
          ) : (
            !zoomed && <ThumbSlider width={thumbWidth} onChange={(thumb_width) => changeSettings({ thumb_width })} />
          )}
          {/* 拡大表示の間は、結果のモードの「閉じる」の代わりに拡大表示の「閉じる」を出す。Escape も拡大表示を先に閉じる */}
          {(zoomed || similar || groups) && (
            <button
              type="button"
              className="button"
              title="閉じる（esc）"
              onClick={zoomed ? () => setZoom(false) : groups ? closeGroups : closeSimilar}
            >
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
            groups && !allGroups?.length
              ? '元が同じ画像の組は見つかりませんでした'
              : !aside && filtered
                ? '条件に合う画像がありません'
                : '画像がありません。「画像を取り込む」を押すか、画像をここにドロップしてください'
          }
          thumbWidth={thumbWidth}
          sections={sections}
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
          keys={!zoomed && !settingsOpen}
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
            onContextMenu={(e) => openContextMenu(zoomed.id, e)}
            people={poseOn ? people : []}
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
              recentLimit={settings.recent_tags ? recentLimit(settings.recent_tags_count) : 0}
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
              onMark={mark}
              onReveal={reveal}
              // ゴミ箱と見つからない画像を開いている間は、この詳細パネルを出さない
              onOpen={() => setZoom(true)}
              onAddToBoard={settings.board_enabled ? addToBoard : undefined}
              onFindSimilar={settings.similarity_enabled ? findSimilar : undefined}
              onMerge={canMerge ? () => setMerging(selected) : undefined}
              onClose={() => toggleDetail(false)}
            />
          )}
        </div>
      </div>

      {savingSmart && (
        <NameDialog
          title="スマートフォルダとして保存"
          label="名前"
          action="保存"
          initial=""
          onSubmit={async (name) => {
            const folder = await invoke<SmartFolder>('create_smart_folder', { name, filter: currentSmart })
            await reloadSmart()
            setOpened({ id: folder.id, saved: currentSmart })
            setSavingSmart(false)
          }}
          onClose={() => setSavingSmart(false)}
        />
      )}

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
          {hiding && hiddenCount > 0 && ` ・ 隠している画像 ${hiddenCount}枚`}
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
        {originSearch && <OriginProgress progress={originSearch} onCancel={() => invoke('cancel_origin_groups')} />}
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
                disabled={(action === 'similar' && !canFindSimilar) || (action === 'parent' && !up)}
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
            : `${asking === 'purge' ? askedName : `ゴミ箱の画像 ${lib.trash.length}枚`}を完全に削除します。元に戻せません。`}
        </ConfirmDialog>
      )}
      {changingCategory && (
        <CategoryDialog
          selected={changingCategory}
          categories={data.categories}
          onAssign={lib.assign}
          onCreate={lib.createCategory}
          onClose={() => setChangingCategory(null)}
        />
      )}
      {merging && (
        <MergeDialog
          root={root}
          images={merging}
          categories={data.categories}
          tags={data.tags}
          onMerge={mergeImages}
          onClose={() => setMerging(null)}
        />
      )}
      {adding && (
        <Suspense fallback={null}>
          <AddDialog images={adding} onClose={() => setAdding(null)} />
        </Suspense>
      )}

      {settingsKind && (
        <SettingsPage
          kind={settingsKind}
          onKind={setSettingsKind}
          onClose={() => setSettingsKind(null)}
          tags={data.tags}
          tagCounts={counts.tags}
          onRenameTag={lib.renameTag}
          onTagReading={lib.setTagReading}
          onMergeTag={mergeTag}
          onDeleteTag={deleteTag}
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
          onFindGroups={findGroups}
          onRestore={restoreLibrary}
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
        (result &&
        result.kind !== 'report' &&
        result.kind !== 'scan' &&
        result.kind !== 'deleted' &&
        result.kind !== 'categoryMerged' &&
        result.kind !== 'info' ? (
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
            {...(result?.kind === 'scan' && {
              // 登録済みの画像がゴミ箱か「見つからない」にあれば、残す場所がないので出さない
              canTidy: (s) => data.images.some((i) => i.id === s.existing),
              onTidy: setTidying,
              onSetAside: setAsideFiles,
            })}
            onClose={() => setShowSkipped(false)}
          />
        ))}
      {tidying && tidyExisting && (
        <TidyDialog
          name={tidying.path.slice(tidying.path.lastIndexOf('/') + 1)}
          dir={tidying.path.slice(root.length + 1, tidying.path.lastIndexOf('/'))}
          existing={tidyExisting}
          categories={data.categories}
          onTidy={tidy}
          onClose={() => setTidying(null)}
        />
      )}
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

// 類似画像検索の結果の帯に出す基準画像のサムネイル。ratio と color は読み込むまでの場所と色
type Lead = { src: string; name: string; ratio?: string; color?: string }

// macOS の wry はドラッグの位置を、型は PhysicalPosition だがポイント（CSS のピクセルと同じ）で、
// ページの上端ではなくウィンドウのタイトルバーを含む上端から数えて渡す（実アプリで測った）。
// その差を、ドラッグが入るたびにウィンドウの外側の高さとページの高さから求める。全画面ではタイトルバーがなく0になる
let titleBar = 0
function measureTitleBar() {
  const win = getCurrentWindow()
  Promise.all([win.outerSize(), win.scaleFactor()]).then(
    ([size, scale]) => (titleBar = Math.max(0, size.height / scale - innerHeight)),
    // モックの画面にはウィンドウがないので、差はないものとする
    () => (titleBar = 0),
  )
}

// Tauri のドラッグの位置が「画像で探す」の上か（FR-608）
function onSearchByImage({ x, y }: { x: number; y: number }) {
  const r = document.getElementById(SEARCH_BY_IMAGE)?.getBoundingClientRect()
  return !!r && x >= r.left && x <= r.right && y - titleBar >= r.top && y - titleBar <= r.bottom
}
