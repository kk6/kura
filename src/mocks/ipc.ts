import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { Gallery, Image } from '../galleryTypes'
import type { Report } from '../importTypes'

type Handler = (args: Record<string, unknown> | undefined) => unknown

// 先頭は外付けドライブが外れたライブラリ。起動時に開けず、選択画面に「見つかりません」が出る
const RECENT = ['/Volumes/外付けSSD/参考資料', '/Users/me/Pictures/Kura ライブラリ']

// 新しく作ったライブラリは空、一覧から開いたライブラリは画像入りにする
let created = false

const openLibrary: Handler = (args) => {
  const path = String(args?.path)
  if (path.startsWith('/Volumes/')) throw `ライブラリが見つかりません（${path}）`
  created = false
  return path
}

const createLibrary: Handler = (args) => {
  created = true
  return args?.path
}

// 縦長・正方形・横長が混ざる2000枚。乱数の種を固定して、スクリーンショットを毎回同じにする
const SIZES = [
  [320, 480],
  [320, 427],
  [320, 320],
  [320, 213],
  [320, 569],
  [320, 240],
]
let seed = 1
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const IMAGES: Image[] = Array.from({ length: 2000 }, (_, i) => {
  const [width, height] = SIZES[Math.floor(random() * SIZES.length)]
  // 写真らしいくすんだ色
  const channel = () => Math.floor(120 + random() * 100).toString(16)
  return {
    id: i + 1,
    file_name: `ref_${String(i + 1).padStart(5, '0')}.jpg`,
    hash: `hash${i + 1}`,
    width,
    height,
    color: `#${channel()}${channel()}${channel()}`,
    category_id: i % 4 === 0 ? null : (i % 5) + 1,
    rating: i % 6,
    imported_at: 1_700_000_000_000 + ((i * 7919) % 2000) * 60_000,
  }
})

const GALLERY: Gallery = {
  images: IMAGES,
  categories: [
    { id: 1, name: 'ポーズ', parent_id: null },
    { id: 2, name: '座り', parent_id: 1 },
    { id: 3, name: '振り返り', parent_id: 1 },
    { id: 4, name: '服飾', parent_id: null },
    { id: 5, name: '制服', parent_id: 4 },
    { id: 6, name: '背景', parent_id: null },
  ],
  tags: [
    { id: 1, name: 'あおり' },
    { id: 2, name: '座り' },
    { id: 3, name: '振り返り' },
  ],
}

const REPORT: Report = {
  added: 477,
  skipped: [
    { path: '/Users/me/Downloads/資料/ポーズ/座り/ref_00012.jpg', kind: 'duplicate', existing: 3 },
    { path: '/Users/me/Downloads/資料/_重複/ref_00012 のコピー.jpg', kind: 'duplicate', existing: 3 },
    { path: '/Users/me/Downloads/資料/服飾/scan.heic', kind: 'unsupported' },
    {
      path: '/Users/me/Downloads/資料/背景/壊れた.png',
      kind: 'error',
      message: '画像を読めません（Format error decoding Png）',
    },
  ],
}

// 進み具合を途中で止めて、e2e で取り込み中の表示を確かめられるようにする
const importPaths: Handler = async () => {
  const total = REPORT.added + REPORT.skipped.length
  await emit('import-progress', { done: 0, total })
  await emit('import-progress', { done: 240, total })
  await new Promise((r) => setTimeout(r, 800))
  await emit('import-progress', { done: total, total })
  return REPORT
}

// 1枚目だけタグ・元URL・メモを持つ
const imageDetail: Handler = (args) => {
  const image = IMAGES.find((i) => i.id === args?.id)
  if (!image) throw `画像が見つかりません（${args?.id}）`
  const first = image.id === 1
  return {
    path: `/Users/me/Pictures/Kura ライブラリ/_未分類/${image.file_name}`,
    file_size: 180_000 + image.id * 1000,
    memo: memos.get(image.id) ?? (first ? '腕の角度と\n肩の線を見る' : ''),
    tags: first ? GALLERY.tags.slice(0, 2) : [],
    source: first ? { image_url: 'https://example.com/images/ref_00001.jpg', page_url: 'https://example.com/gallery/pose' } : null,
  }
}

// 保存したメモは、選び直したときの詳細に出す。e2e で失敗の表示を確かめるため、「失敗」を含むメモは保存しない
const memos = new Map<number, string>()
const setMemo: Handler = (args) => {
  const memo = String(args?.memo)
  if (memo.includes('失敗')) throw 'disk I/O error'
  memos.set(Number(args?.id), memo)
}

const setRating: Handler = (args) => {
  const image = IMAGES.find((i) => i.id === args?.id)!
  image.rating = Number(args?.rating)
}

// Tauri のコマンドを足したら、同じ名前でここに応答を足す
const handlers: Record<string, Handler> = {
  list_recent_libraries: () => RECENT,
  location_warning: () => null,
  open_library: openLibrary,
  create_library: createLibrary,
  import_paths: importPaths,
  load_gallery: () => (created ? { images: [], categories: [], tags: [] } : GALLERY),
  image_detail: imageDetail,
  set_memo: setMemo,
  set_rating: setRating,
  'plugin:dialog|open': (args) =>
    (args?.options as { multiple?: boolean })?.multiple
      ? ['/Users/me/Downloads/資料']
      : '/Users/me/Pictures/新しいライブラリ',
}

export function installMockIPC() {
  // ドラッグ＆ドロップは getCurrentWebview() で受けるので、ウィンドウの情報も用意する
  mockWindows('main')
  // listen と emit を IPC なしで動かす。e2e ではドロップを tauri://drag-drop の emit で起こす
  mockIPC(
    (cmd, args) => {
      const handler = handlers[cmd]
      if (!handler) throw new Error(`モックが未定義のコマンド: ${cmd}`)
      return handler(args as Record<string, unknown> | undefined)
    },
    { shouldMockEvents: true },
  )
  // ブラウザは asset: のURLを読めないので透明な画像を返し、代表色が見えるようにする。
  // e2e で読みに行ったパスを確かめられるように、パスをURLの末尾に残す
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => string } })
    .__TAURI_INTERNALS__
  internals.convertFileSrc = (path) => `${BLANK}#${path}`
}

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
