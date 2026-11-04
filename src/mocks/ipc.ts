import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { subtree } from '../categoryTree'
import type { Assigned, Gallery, Image } from '../galleryTypes'
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

// 縦長・正方形・横長が混ざる2000枚。乱数の種を固定して、スクリーンショットを毎回同じにする。
// ?images=20000 で枚数を変えられる（e2e で絞り込みの速さを測るため）
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
const COUNT = Number(new URLSearchParams(location.search).get('images') ?? 2000)
const IMAGES: Image[] = Array.from({ length: COUNT }, (_, i) => {
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
    // 1枚目はメモと「あおり」「座り」を持つ。2〜10枚目はタグなし、11枚目からは id で決まるタグを持つ
    memo: i === 0 ? '腕の角度と\n肩の線を見る' : '',
    tags: i === 0 ? [1, 2] : i < 10 ? [] : [1, 2, 3].filter((t) => (i + 1) % (t * 2 + 1) === 0),
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

// 1枚目だけ元URLを持つ
const imageDetail: Handler = (args) => {
  const image = IMAGES.find((i) => i.id === args?.id)
  if (!image) throw `画像が見つかりません（${args?.id}）`
  const first = image.id === 1
  return {
    path: `/Users/me/Pictures/Kura ライブラリ/_未分類/${image.file_name}`,
    file_size: 180_000 + image.id * 1000,
    source: first ? { image_url: 'https://example.com/images/ref_00001.jpg', page_url: 'https://example.com/gallery/pose' } : null,
  }
}

// e2e で失敗の表示を確かめるため、「失敗」を含むメモは保存しない
const setMemo: Handler = (args) => {
  const memo = String(args?.memo)
  if (memo.includes('失敗')) throw 'disk I/O error'
  IMAGES.find((i) => i.id === args?.id)!.memo = memo
}

const setRating: Handler = (args) => {
  const image = IMAGES.find((i) => i.id === args?.id)!
  image.rating = Number(args?.rating)
}

// e2e で失敗の表示を確かめるため、ref_00007 は移せない
const setCategory: Handler = (args) => {
  const category = args?.category as number | null
  if (category !== null && !GALLERY.categories.some((c) => c.id === category)) throw `カテゴリが見つかりません（${category}）`
  const out: Assigned = { moved: [], failed: [] }
  for (const id of args?.ids as number[]) {
    const image = IMAGES.find((i) => i.id === id)!
    if (id === 7) {
      out.failed.push({ id, message: `移動元が見つかりません（_未分類/${image.file_name}）` })
      continue
    }
    image.category_id = category
    out.moved.push({ id, file_name: image.file_name })
  }
  return out
}

// src-tauri/src/category.rs の検査と同じ。同名の判定は、本物では実際のフォルダの中身で行う
const checkCategory = (id: number, parent: number | null, name: string) => {
  if (!name) throw 'カテゴリ名を入力してください'
  if (/[/:]/.test(name)) throw 'カテゴリ名に / と : は使えません'
  if (name.startsWith('.')) throw 'カテゴリ名を . で始めることはできません'
  if (name === '_未分類') throw '_未分類 はカテゴリ名に使えません'
  const k = key(name)
  if (GALLERY.categories.some((c) => c.id !== id && c.parent_id === parent && key(c.name) === k))
    throw `同じ名前のファイルかフォルダがあります（${name}）`
}

const categoryOf = (id: unknown) => {
  const c = GALLERY.categories.find((c) => c.id === id)
  if (!c) throw `カテゴリが見つかりません（${id}）`
  return c
}

const createCategory: Handler = (args) => {
  const parent = (args?.parent as number | null) ?? null
  if (parent !== null) categoryOf(parent)
  const name = String(args?.name).normalize('NFC')
  checkCategory(0, parent, name)
  const id = Math.max(...GALLERY.categories.map((c) => c.id)) + 1
  GALLERY.categories.push({ id, name, parent_id: parent })
  return id
}

const renameCategory: Handler = (args) => {
  const c = categoryOf(args?.id)
  const name = String(args?.name).normalize('NFC')
  checkCategory(c.id, c.parent_id, name)
  c.name = name
}

const moveCategory: Handler = (args) => {
  const c = categoryOf(args?.id)
  const parent = (args?.parent as number | null) ?? null
  for (let p = parent; p !== null; p = categoryOf(p).parent_id)
    if (p === c.id) throw 'カテゴリを自分自身や子孫の下へは移せません'
  checkCategory(c.id, parent, c.name)
  c.parent_id = parent
}

// src-tauri/src/category.rs の delete と同じく、移せない画像（ref_00007 は「座り」にある）があればカテゴリを消さない
const deleteCategory: Handler = (args) => {
  const c = categoryOf(args?.id)
  const ids = subtree(GALLERY.categories, c.id)
  const images = IMAGES.filter((i) => i.category_id !== null && ids.has(i.category_id)).map((i) => i.id)
  const out = setCategory({ ids: images, category: null }) as Assigned
  if (out.failed.length) return { ...out, error: '未分類へ移せない画像があるので、カテゴリを削除しませんでした' }
  GALLERY.categories = GALLERY.categories.filter((x) => !ids.has(x.id))
  return { ...out, error: null }
}

// 画像のファイル名の変更。Rust と同じく、同じフォルダ（カテゴリ）に同名があればエラーにする
const renameImage: Handler = (args) => {
  const stem = String(args?.stem)
  if (!stem) throw 'ファイル名を入力してください'
  if (/[/:]/.test(stem)) throw 'ファイル名に / と : は使えません'
  if (stem.startsWith('.')) throw 'ファイル名を . で始めることはできません'
  const image = IMAGES.find((i) => i.id === args?.id)
  if (!image) throw `画像が見つかりません（${args?.id}）`
  const dot = image.file_name.lastIndexOf('.')
  const name = (dot > 0 ? stem + image.file_name.slice(dot) : stem).normalize('NFC')
  const k = key(name)
  if (IMAGES.some((i) => i !== image && i.category_id === image.category_id && key(i.file_name) === k))
    throw `同じ名前のファイルかフォルダがあります（${name}）`
  image.file_name = name
  return name
}

const tagsOf = (id: number) => IMAGES.find((i) => i.id === id)!.tags

const countTags: Handler = (args) => {
  const ids = args?.ids as number[]
  return GALLERY.tags
    .map((t) => ({ ...t, count: ids.filter((id) => tagsOf(id).includes(t.id)).length }))
    .filter((t) => t.count > 0)
}

const key = (name: string) => name.trim().normalize('NFC').toLowerCase()
const addTag: Handler = (args) => {
  const name = String(args?.name).trim().normalize('NFC')
  if (!name) throw 'タグ名を入力してください'
  let tag = GALLERY.tags.find((t) => key(t.name) === key(name))
  if (!tag) {
    tag = { id: Math.max(...GALLERY.tags.map((t) => t.id)) + 1, name }
    GALLERY.tags.push(tag)
    GALLERY.tags.sort((a, b) => (a.name < b.name ? -1 : 1))
  }
  for (const id of args?.ids as number[]) if (!tagsOf(id).includes(tag.id)) tagsOf(id).push(tag.id)
  return tag
}

const removeTag: Handler = (args) => {
  for (const i of IMAGES) if ((args?.ids as number[]).includes(i.id)) i.tags = i.tags.filter((t) => t !== args?.tagId)
}

// Tauri のコマンドを足したら、同じ名前でここに応答を足す
const handlers: Record<string, Handler> = {
  list_recent_libraries: () => RECENT,
  location_warning: () => null,
  open_library: openLibrary,
  create_library: createLibrary,
  import_paths: importPaths,
  // 本物の IPC と同じく複製を返す。画面の state とモックの値を同じ配列にしないため
  load_gallery: () => (created ? { images: [], categories: [], tags: [] } : structuredClone(GALLERY)),
  image_detail: imageDetail,
  set_memo: setMemo,
  set_rating: setRating,
  set_category: setCategory,
  rename_image: renameImage,
  create_category: createCategory,
  rename_category: renameCategory,
  move_category: moveCategory,
  delete_category: deleteCategory,
  image_tags: countTags,
  add_tag: addTag,
  remove_tag: removeTag,
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
