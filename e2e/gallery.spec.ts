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
