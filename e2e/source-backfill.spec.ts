import { expect, test, type Page } from './fixtures'

async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await page.getByRole('button', { name: '設定' }).click()
  return page.getByRole('dialog', { name: '設定' })
}

test('設定の「元URLを補完」で進み具合と、補完・記録なし・読み取り失敗・対象外の件数を出す', async ({ page }) => {
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: '元URLを補完' }).click()

  await expect(settings.getByRole('button', { name: '元URLを補完' })).toBeDisabled()
  await expect(settings.getByRole('status')).toContainText(/補完中 \d \/ 6枚/)
  // 補完の間も設定を閉じて一覧を使え、ステータスバーに進み具合が出る
  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(page.getByRole('contentinfo')).toContainText(/元URLを補完中 \d \/ 6枚/)
  await expect(page.getByRole('progressbar', { name: '元URLを補完する進み具合' })).toBeVisible()

  await expect(page.getByRole('contentinfo')).not.toContainText('元URLを補完中', { timeout: 5000 })
  await page.getByRole('button', { name: '設定' }).click()
  await expect(settings).toContainText('完了：補完 3枚、記録なし 2枚、読み取り失敗 1枚、対象外 1994枚')
  await expect(settings.getByRole('button', { name: '元URLを補完' })).toBeEnabled()
  await settings.screenshot({ path: 'test-results/source-backfill.png' })
})

test('補完を中断すると、それまでの件数と中断したことを出し、もう一度始められる', async ({ page }) => {
  const settings = await openSettings(page)
  await settings.getByRole('button', { name: '元URLを補完' }).click()
  await expect(settings.getByRole('status')).toContainText(/補完中 [1-5] \/ 6枚/)

  await settings.getByRole('button', { name: '中断' }).click()

  await expect(settings).toContainText(/お知らせ：中断しました。補完 [1-3]枚/)
  await expect(settings.getByRole('button', { name: '中断' })).toHaveCount(0)
  await settings.getByRole('button', { name: '元URLを補完' }).click()
  await expect(settings.getByRole('status')).toContainText('補完中')
})
