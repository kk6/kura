import { expect, test } from '@playwright/test'

type TauriWindow = { __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> } }

test('起動時に前回のライブラリが見つからなければ、選択画面にその旨と最近使った一覧を出す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')

  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('alert')).toHaveText('エラー：ライブラリが見つかりません（/Volumes/外付けSSD/参考資料）')
  await expect(screen.getByRole('button', { name: /参考資料/ })).toBeVisible()
  await expect(screen.getByRole('button', { name: /Kura ライブラリ/ })).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/library-select.png' })
})

test('見つからないライブラリを一覧から開いても、選択画面のまま見つからないと出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /参考資料/ }).click()
  await expect(page.getByRole('alert')).toContainText('見つかりません')
  await expect(page.getByRole('banner')).toHaveCount(0)
})

test('ライブラリを新しく作るとギャラリー画面を出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいライブラリを作る' }).click()
  await expect(page.getByRole('banner')).toBeVisible()
})

test('一覧からライブラリを開くとギャラリー画面の枠が表示される', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()

  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'サイドバー' })).toBeVisible()
  await expect(page.getByRole('main', { name: '画像の一覧' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '詳細' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/gallery.png' })
})

test('Tauri のコマンドがモックに差し替わっている', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('main', { name: 'ライブラリ選択' })).toBeVisible()
  const message = await page.evaluate(() => {
    const tauri = (window as unknown as TauriWindow).__TAURI_INTERNALS__
    return tauri.invoke('no_such_command').catch((e: unknown) => String(e))
  })
  expect(message).toContain('モックが未定義のコマンド: no_such_command')
})

async function openGallery(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('banner')).toBeVisible()
}

test('フォルダを取り込むと、ステータスバーに進み具合と結果を出し、スキップの一覧を開ける', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await page.getByRole('button', { name: 'フォルダを取り込む' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('取り込み中 240 / 481枚')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '240')
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/import-progress.png' })

  await expect(status).toContainText('完了：取り込み 477枚')
  await expect(status.getByRole('button', { name: '注意：スキップ 3枚' })).toBeVisible()
  await status.getByRole('button', { name: 'エラー：取り込めない 1件' }).click()

  const dialog = page.getByRole('dialog', { name: '取り込まなかったファイル（4件）' })
  await expect(dialog.getByRole('listitem')).toHaveCount(4)
  await expect(dialog).toContainText('注意：同じ画像がライブラリ（ゴミ箱を含む）にあります')
  await expect(dialog).toContainText('注意：対応していない形式です')
  await expect(dialog).toContainText('エラー：取り込めませんでした（画像を読めません')
  await page.screenshot({ path: 'test-results/import-skipped.png' })

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(errors).toEqual([])
})

test('ドロップしたファイルを取り込む', async ({ page }) => {
  await openGallery(page)

  await page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'tauri://drag-drop',
      payload: { paths: ['/Users/me/Downloads/a.jpg'], position: { x: 0, y: 0 } },
    }),
  )

  await expect(page.getByRole('contentinfo')).toContainText('完了：取り込み 477枚')
})

const thumbs = (page: import('@playwright/test').Page) => page.getByRole('main', { name: '画像の一覧' }).getByRole('img')

// 描いているサムネイルの列の数（transform の x の種類の数）
const columnCount = (page: import('@playwright/test').Page) =>
  thumbs(page).evaluateAll((imgs) => new Set(imgs.map((i) => (i as HTMLElement).style.transform.split(',')[0])).size)

test('一覧は2000枚のうち表示範囲の近くだけを描き、サムネイルは開いたライブラリの .kura/thumbs から読む', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await expect(page.getByRole('contentinfo')).toContainText('2000枚')
  const count = await thumbs(page).count()
  expect(count).toBeGreaterThan(20)
  expect(count).toBeLessThan(200)
  await expect(thumbs(page).first()).toHaveAttribute(
    'src',
    /#\/Users\/me\/Pictures\/Kura ライブラリ\/\.kura\/thumbs\/hash\d+\.jpg$/,
  )

  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  await expect(sidebar.getByRole('listitem').filter({ hasText: 'すべての画像' })).toContainText('2000')
  await expect(sidebar.getByRole('listitem').filter({ hasText: '未分類' })).toContainText('500')
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  await expect(categories.getByRole('listitem').filter({ hasText: 'ポーズ' })).toContainText('座り')
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('listitem')).toHaveText(['あおり', '座り', '振り返り'])
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/gallery-list.png' })
})

test('一番下までスクロールしても、表示範囲のサムネイルを描く', async ({ page }) => {
  await openGallery(page)
  const list = page.getByRole('main', { name: '画像の一覧' })

  await list.evaluate((el) => (el.scrollTop = el.scrollHeight))

  // 一覧の枠の中に見えているサムネイルの数
  const inView = () =>
    list.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return Array.from(el.querySelectorAll('img')).filter((i) => {
        const r = i.getBoundingClientRect()
        return r.bottom > box.top && r.top < box.bottom
      }).length
    })
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(10000)
  await expect.poll(inView).toBeGreaterThan(5)
  expect(await thumbs(page).count()).toBeLessThan(200)
  await page.screenshot({ path: 'test-results/gallery-bottom.png' })
})

test('スライダーでサムネイルを小さくすると列が増える', async ({ page }) => {
  await openGallery(page)
  const before = await columnCount(page)

  await page.getByRole('slider', { name: 'サムネイルの大きさ' }).fill('100')

  await expect.poll(() => columnCount(page)).toBeGreaterThan(before)
  await page.screenshot({ path: 'test-results/gallery-small.png' })
})

test('並べ替えを変えると並び順が変わる', async ({ page }) => {
  await openGallery(page)
  const sort = page.getByRole('combobox', { name: '並べ替え' })
  const first = () => thumbs(page).first().getAttribute('alt')

  await sort.selectOption({ label: 'ファイル名' })
  await expect.poll(first).toBe('ref_00001.jpg')

  await sort.selectOption({ label: '評価' })
  // 評価5（i % 6 === 5）の中で取り込み日が一番新しい画像
  await expect.poll(first).not.toBe('ref_00001.jpg')

  await sort.selectOption({ label: 'ランダム' })
  await expect(thumbs(page).first()).toBeVisible()
})

test('画像のないライブラリでは、一覧に取り込み方を出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいライブラリを作る' }).click()

  await expect(page.getByRole('main', { name: '画像の一覧' })).toContainText('画像がありません')
  await expect(page.getByRole('contentinfo')).toContainText('0枚')
})
