import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open } from '@tauri-apps/plugin-dialog'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rememberTag } from './choices'
import { useContextMenu } from './contextMenu'
import { flushAll } from './flush'
import GalleryHeader from './GalleryHeader'
import GalleryToolbar, { THUMB_MAX, THUMB_MIN, ThumbSlider } from './GalleryToolbar'
import { addTag, dropTag, editImages, named, removeImages, swapTag } from './galleryData'
import Detail from './Detail'
import { countImages, type Filter, filterImages, NO_FILTER } from './filter'
import MoveFailDialog from './MoveFailDialog'
import Masonry from './Masonry'
import SettingsDialog from './SettingsDialog'
import Sidebar from './Sidebar'
import SkipDialog from './SkipDialog'
import Status from './Status'
import StatusbarResult, { type Result } from './StatusbarResult'
import TagDialog from './TagDialog'
import MissingPanel from './MissingPanel'
import TrashPanel from './TrashPanel'
import type { Detail as DetailData, Done, Restored, Settings } from './galleryTypes'
import type { Backfill, BackfillCounts, ImportProgress, Report, ScanReport } from './importTypes'
import { EMPTY_SELECTION, keepOnly, select } from './selection'
import { type SortKey, sortImages } from './sort'
import { useLibrary } from './useLibrary'
import { useZoom, ZOOM_STEP } from './useZoom'
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

  // ゴミ箱と見つからない画像は新しい順に出し、並べ替えと絞り込みはしない
  const listed = inTrash ? trash : inMissing ? missing : images
  // 一覧のスクロールを先頭に戻す契機。画像の中身（タグ・メモなど）の変化では戻さない
  const listKey = JSON.stringify([sort, filter, aside])
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
  // リスナーは一度だけ登録する。呼ばれたときに今の描画の関数を使うよう、ref を通す
  const handlers = { scan, onKey, start, leave, openBoard, addToBoard, revealImage }
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
      />

      <GalleryToolbar
        title={title}
        count={listed.length}
        sort={aside ? undefined : sort}
        onSort={setSort}
        detailShown={detailShown}
        onToggleDetail={() => toggleDetail()}
      >
        {/* 拡大表示の間は、サムネイルの大きさの代わりに画像の倍率を出す。後ろに隠れたサムネイルを変えても見えないため */}
        {zoomed && zoomView.frame ? (
          <ZoomSlider zoom={zoomView} image={zoomed} frame={zoomView.frame} />
        ) : (
          !zoomed && <ThumbSlider width={thumbWidth} onChange={(thumb_width) => changeSettings({ thumb_width })} />
        )}
      </GalleryToolbar>

      <Masonry
        root={root}
        images={listed}
        scrollKey={listKey}
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
        <ZoomPanel
          zoom={zoomView}
          image={zoomed}
          // 元の画像のパスがわかるまではサムネイルを出す
          src={convertFileSrc(shown?.detail?.path ?? `${root}/.kura/thumbs/${zoomed.hash}.jpg`)}
          onPrev={at > 0 ? () => step(-1) : undefined}
          onNext={at < order.length - 1 ? () => step(1) : undefined}
          onClose={() => setZoom(false)}
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
