// README とユーザーガイドのスクリーンショット（docs/images/）を撮り直す。npm run docs:screenshots で流す。
// モックの開発サーバーを開き、KURA_DOCS_PHOTOS の見本の写真（商用利用できるもの）を画像として写す
import { expect, type Page, test } from '@playwright/test'
import { boardWith } from './board-helpers'

// Retina（2倍）で撮ると1枚 300KB を超えるので、等倍で撮る
test.use({ deviceScaleFactor: 1 })
// ダイアログが開く動きの途中で撮らないよう、動きを止める（docs/design.md「動き」）
test.use({ contextOptions: { reducedMotion: 'reduce' } })

// 写真は PNG だと1枚 300KB を超えるので JPEG にする。写真を読み終えてから撮る
async function shot(page: Page, name: string) {
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete))
  await page.screenshot({ path: `docs/images/${name}.jpg`, type: 'jpeg', quality: 65 })
}

async function openGallery(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  // 開いた後の差分検出が終わり、ステータスバーに結果が出るまで待つ
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

test('ライブラリ選択画面', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('見つかりません')
  await shot(page, 'library-select')
})

test('一覧と詳細パネル', async ({ page }) => {
  await openGallery(page)
  // メモとタグを持つ1枚目（ファイル名の順で先頭）を選ぶ
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption('ファイル名')
  await page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first().click()
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText('を見る')
  await shot(page, 'gallery')
})

test('取り込みとスキップの一覧', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('button', { name: 'フォルダを取り込む' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('完了：取り込み 477枚')
  await shot(page, 'import-result')
  await status.getByRole('button', { name: '注意：スキップ 3枚' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await shot(page, 'skip-dialog')
})

test('拡大表示', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first().dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toBeVisible()
  await shot(page, 'zoom')
})

test('タグ管理', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('button', { name: 'タグを管理する' }).click()
  await expect(page.getByRole('dialog', { name: 'タグを管理する' })).toBeVisible()
  await shot(page, 'tag-dialog')
})

test('ゴミ箱', async ({ page }) => {
  await openGallery(page)
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /^ゴミ箱/ })
    .click()
  await page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first().click()
  await shot(page, 'trash')
})

test('設定', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('button', { name: '設定' }).click()
  await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible()
  await shot(page, 'settings')
})

test('アイデアボード', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mock.boards')) return
    const board = (id: number, name: string) => ({ id, name, placement_count: 0, updated_at: id })
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({ boards: [board(1, '構図'), board(2, '服のしわ')], last: 1, next: 3 }),
    )
  })
  const { items } = await boardWith(page, 6)
  // 専用ウィンドウの初めの大きさで撮る。狭いギャラリーではサムネイルを押しにくいので、ボードを開いてから縮める
  await page.setViewportSize({ width: 1040, height: 640 })
  await page.getByRole('button', { name: '全体を表示' }).click()
  await items.nth(2).click()
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await shot(page, 'board')
})

test('ボードに追加', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mock.boards')) return
    const board = (id: number, name: string) => ({ id, name, placement_count: 0, updated_at: id })
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({ boards: [board(1, '構図'), board(2, '服のしわ')], last: 1, next: 3 }),
    )
  })
  await openGallery(page)
  const thumbs = page.getByRole('main', { name: '画像の一覧' }).getByRole('img')
  await thumbs.nth(0).click()
  await thumbs.nth(1).click({ modifiers: ['Meta'] })
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await expect(page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('combobox')).toHaveValue('1')
  await shot(page, 'board-add')
})
