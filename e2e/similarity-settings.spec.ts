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
  await expect(confirm).toContainText('441 MB')
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

  await expect(settings.getByRole('status')).toContainText(/モデルをダウンロード中 \d+ MB \/ 441 MB/)
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

test('ON にすると特徴量の計算がステータスバーに進み、設定に済み・残り・計算できなかった枚数を出す', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.modelReady', '1'))
  const settings = await openSettings(page)
  await expect(settings).not.toContainText('計算済み')
  await settings.getByRole('checkbox', { name: '類似画像検索を使う' }).click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()

  const bar = page.getByRole('contentinfo')
  await expect(bar).toContainText(/特徴量を計算中 \d+ \/ \d+枚/)
  await expect(bar.getByRole('progressbar', { name: '特徴量を計算する進み具合' })).toBeVisible()
  await expect(settings).toContainText('（計算中）')

  await expect(bar).not.toContainText('特徴量を計算中')
  await expect(settings).toContainText(/計算済み \d+枚、残り 0枚、計算できなかった 0枚/)
  await expect(settings).not.toContainText('（計算中）')
})

test('計算が止まるとエラーを出し、「再計算」で残りを計算する', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    sessionStorage.setItem('mock.modelReady', '1')
    sessionStorage.setItem('mock.stopFeatures', '1')
  })
  const settings = await openSettings(page)
  await settings.getByRole('checkbox', { name: '類似画像検索を使う' }).click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()

  const stopped = 'エラー：特徴量の計算が止まりました'
  await expect(page.getByRole('contentinfo')).toContainText(stopped)
  await expect(settings).toContainText(stopped)
  await expect(settings).toContainText(/残り 1枚、計算できなかった 1枚/)
  await settings.screenshot({ path: 'test-results/similarity-features-stopped.png' })

  await settings.getByRole('button', { name: '再計算' }).click()

  await expect(settings).toContainText(/残り 0枚、計算できなかった 0枚/)
  await expect(settings).not.toContainText(stopped)
  await expect(page.getByRole('contentinfo')).not.toContainText(stopped)
  await settings.screenshot({ path: 'test-results/similarity-features.png' })
})

test('OFF に戻すと計算の状況を出さない', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.modelReady', '1'))
  const settings = await openSettings(page)
  const check = settings.getByRole('checkbox', { name: '類似画像検索を使う' })
  await check.click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()
  await expect(settings).toContainText('計算済み')

  await check.click()

  await expect(settings).not.toContainText('計算済み')
  await expect(page.getByRole('contentinfo')).not.toContainText('特徴量を計算中')
})

// 3a から更新した利用者。ON のまま、内容のモデルはあってポーズのモデルだけがない。
// ON にしてからポーズのモデルを消したことにし、設定を開き直す
async function openUpdated(page: Page, extra: Record<string, string> = {}) {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.modelReady', '1'))
  let settings = await openSettings(page)
  await settings.getByRole('checkbox', { name: '類似画像検索を使う' }).click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()
  await expect(settings.getByRole('checkbox', { name: '類似画像検索を使う' })).toBeChecked()
  await settings.getByRole('button', { name: '閉じる' }).click()
  await page.evaluate((extra) => {
    sessionStorage.setItem('mock.missingPose', '1')
    for (const [k, v] of Object.entries(extra)) sessionStorage.setItem(k, v)
  }, extra)
  await page.getByRole('button', { name: '設定' }).click()
  settings = page.getByRole('dialog', { name: '設定' })
  return settings
}

const POSE_TEXT = '「体の姿勢」で比べるには、ポーズのモデル（約70 MB）が必要です'

test('ON でポーズのモデルがないときだけ、説明と大きさと「ダウンロード」を出す', async ({ page }) => {
  const settings = await openUpdated(page)
  await expect(settings).toContainText(POSE_TEXT)
  await expect(settings.getByRole('button', { name: 'ダウンロード', exact: true })).toBeVisible()
  // 押すまで通信しない
  expect(await page.evaluate(() => sessionStorage.getItem('mock.missingPose'))).toBe('1')
  await settings.screenshot({ path: 'test-results/similarity-pose-missing.png' })

  await settings.getByRole('checkbox', { name: '類似画像検索を使う' }).click()
  await expect(settings).not.toContainText(POSE_TEXT)
  await expect(settings.getByRole('button', { name: 'ダウンロード', exact: true })).toHaveCount(0)
})

test('モデルがそろっていれば「ダウンロード」を出さない', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => sessionStorage.setItem('mock.modelReady', '1'))
  const settings = await openSettings(page)
  await settings.getByRole('checkbox', { name: '類似画像検索を使う' }).click()
  await page.getByRole('button', { name: 'ダウンロードして使う' }).click()
  await expect(settings).toContainText('計算済み')

  await expect(settings).not.toContainText(POSE_TEXT)
})

test('「ダウンロード」を押すと進み具合を出し、そろうと欄が消えて ON のまま', async ({ page }) => {
  const settings = await openUpdated(page)
  await settings.getByRole('button', { name: 'ダウンロード', exact: true }).click()

  await expect(settings.getByRole('status')).toContainText(/モデルをダウンロード中 \d+ MB \/ 70 MB/)
  await expect(settings.getByRole('button', { name: 'ダウンロード', exact: true })).toHaveCount(0)
  await settings.screenshot({ path: 'test-results/similarity-pose-download.png' })

  await expect(settings).not.toContainText(POSE_TEXT)
  await expect(settings.getByRole('status')).toHaveCount(0)
  await expect(settings.getByRole('checkbox', { name: '類似画像検索を使う' })).toBeChecked()
  expect(await saved(page)).toBe(true)
})

test('ポーズのモデルのダウンロードに失敗するとエラーと「再試行」を出し、ON のまま', async ({ page }) => {
  const settings = await openUpdated(page, { 'mock.failModel': '1' })
  await settings.getByRole('button', { name: 'ダウンロード', exact: true }).click()

  await expect(settings).toContainText('エラー：モデルをダウンロードできません')
  await expect(settings.getByRole('checkbox', { name: '類似画像検索を使う' })).toBeChecked()
  expect(await saved(page)).toBe(true)
  await expect(settings).toContainText(POSE_TEXT)
  await expect(settings.getByRole('button', { name: 'ダウンロード', exact: true })).toHaveCount(0)
  await settings.screenshot({ path: 'test-results/similarity-pose-failed.png' })

  await page.evaluate(() => sessionStorage.removeItem('mock.failModel'))
  await settings.getByRole('button', { name: '再試行' }).click()

  await expect(settings).not.toContainText(POSE_TEXT)
  await expect(settings).not.toContainText('エラー：')
})
