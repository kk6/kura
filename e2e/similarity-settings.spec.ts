import { expect, test, type Page } from './fixtures'

async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await page.getByRole('button', { name: '設定' }).click()
  return page.getByRole('dialog', { name: '設定' })
}

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.settings') ?? '{}').similarity_enabled ?? false)
const downloaded = (page: Page) => page.evaluate(() => !!sessionStorage.getItem('mock.modelReady'))

test('初期値は OFF で、ON にする前にモデルの大きさを見せ、キャンセルすると OFF のままダウンロードしない', async ({
  page,
}) => {
  const settings = await openSettings(page)
  const check = settings.getByRole('checkbox', { name: '類似画像検索を使う' })
  await expect(check).not.toBeChecked()

  await check.click()
  const confirm = page.getByRole('dialog', { name: '類似画像検索を使う' })
  await expect(confirm).toContainText('372 MB')
  await confirm.screenshot({ path: 'test-results/similarity-confirm.png' })
  await confirm.getByRole('button', { name: 'キャンセル' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(check).not.toBeChecked()
  expect(await downloaded(page)).toBe(false)
  expect(await saved(page)).toBe(false)
})

test('確認して進めると進み具合を出し、そろってから ON を保存する', async ({ page }) => {
  const settings = await openSettings(page)
  const check = settings.getByRole('checkbox', { name: '類似画像検索を使う' })
  await check.click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()

  await expect(settings.getByRole('status')).toContainText(/モデルをダウンロード中 \d+ MB \/ 372 MB/)
  await expect(check).toBeDisabled()
  await expect(check).not.toBeChecked()
  await settings.screenshot({ path: 'test-results/similarity-download.png' })

  await expect(check).toBeChecked()
  await expect(check).toBeEnabled()
  await expect(settings.getByRole('status')).toHaveCount(0)
  await expect.poll(() => saved(page)).toBe(true)
})

test('ダウンロードに失敗するとエラーと「再試行」を出して OFF のままにし、再試行で ON になる', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.failModel', '1'))
  const settings = await openSettings(page)
  const check = settings.getByRole('checkbox', { name: '類似画像検索を使う' })
  await check.click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()

  await expect(settings).toContainText('エラー：モデルをダウンロードできません')
  await expect(check).not.toBeChecked()
  expect(await saved(page)).toBe(false)
  await settings.screenshot({ path: 'test-results/similarity-failed.png' })

  await page.evaluate(() => sessionStorage.removeItem('mock.failModel'))
  await settings.getByRole('button', { name: '再試行' }).click()

  await expect(check).toBeChecked()
  await expect(settings.getByRole('button', { name: '再試行' })).toHaveCount(0)
  await expect(settings).not.toContainText('エラー：')
})

test('OFF に戻してもう一度 ON にすると、ダウンロードし直さずに ON になる', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.modelReady', '1'))
  const settings = await openSettings(page)
  const check = settings.getByRole('checkbox', { name: '類似画像検索を使う' })
  await check.click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()
  await expect(check).toBeChecked()

  await check.click()
  await expect(check).not.toBeChecked()
  await expect.poll(() => saved(page)).toBe(false)
  // OFF にしてもモデルは消さない
  expect(await downloaded(page)).toBe(true)

  await check.click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()
  await expect(check).toBeChecked()
  await expect(settings.getByRole('status')).toHaveCount(0)
})
