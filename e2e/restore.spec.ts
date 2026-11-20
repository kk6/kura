import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { openGallery } from './gallery-helpers'

// 設定から「管理情報をインポート…」で path のファイルを選ぶ（FR-107）。モックのファイル選択は mock.openPath を返す
async function pick(page: Page, path: string) {
  await page.evaluate((path) => sessionStorage.setItem('mock.openPath', path), path)
  await page.getByRole('button', { name: '設定' }).click()
  await page.getByRole('dialog', { name: '設定' }).getByRole('button', { name: '管理情報をインポート…' }).click()
}

test('選んだ管理情報の日時と枚数を確かめてからインポートし、開き直して差分を確かめる', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await openGallery(page)
  const status = page.getByRole('contentinfo')
  // 絞り込んでおく。作り直した画面は絞り込みのない状態で始まる
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /^あおり/ })
    .click()
  await expect(status).toContainText('/ 2000枚')
  await pick(page, '/Users/me/Documents/Kura ライブラリ-2026-11-01.db')

  const confirm = page.getByRole('dialog', { name: '管理情報をインポート' })
  await expect(confirm).toContainText('にエクスポートした管理情報（1990枚）で、今の管理情報（2000枚）を置き換えます')
  await expect(confirm).toContainText('.kura/backups')
  await expect(confirm.getByRole('status')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/restore-confirm.png' })

  // 戻すとボードを閉じてから戻し、ギャラリーを作り直す。開き直した後に差分を確かめる
  await confirm.getByRole('button', { name: 'インポート' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(() => logs.filter((l) => l.startsWith('restore:')))
    .toEqual(['restore: /Users/me/Documents/Kura ライブラリ-2026-11-01.db'])
  await expect(status).not.toContainText('/ 2000枚')
  await expect(status).toContainText('差分を反映')
})

test('別のライブラリかもしれないときは警告を出し、やめるとインポートしない', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await openGallery(page)
  await pick(page, '/Users/me/Documents/別のライブラリ.db')

  const confirm = page.getByRole('dialog', { name: '管理情報をインポート' })
  await expect(confirm).toContainText('別のライブラリの管理情報かもしれません')
  await expect(confirm).toContainText('見つかるのは12枚だけです')
  await page.screenshot({ path: 'test-results/restore-other-library.png' })
  await confirm.getByRole('button', { name: 'キャンセル' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible()
  expect(logs.filter((l) => l.startsWith('restore:'))).toEqual([])
})

test('管理情報でないファイルと、インポートした管理情報を開けなかったときは、設定にエラーを出す', async ({ page }) => {
  await openGallery(page)
  await pick(page, '/Users/me/Pictures/画像.png')
  const settings = page.getByRole('dialog', { name: '設定' })
  await expect(settings).toContainText('エラー：管理情報のファイルではありません')
  await expect(page.getByRole('dialog', { name: '管理情報をインポート' })).toHaveCount(0)

  await page.evaluate(() => sessionStorage.setItem('mock.openPath', '/Users/me/Documents/開けない.db'))
  await settings.getByRole('button', { name: '管理情報をインポート…' }).click()
  await page.getByRole('dialog', { name: '管理情報をインポート' }).getByRole('button', { name: 'インポート' }).click()
  await expect(settings).toContainText(
    'エラー：インポートした管理情報を開けないので、インポートする前の管理情報に戻しました',
  )
})

test('取り込みの途中ではインポートせず、理由を設定に出す', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await openGallery(page)
  await page.evaluate(() => sessionStorage.setItem('mock.importDelay', '10000'))
  await page.getByRole('button', { name: '画像を取り込む' }).click()
  await expect(page.getByRole('contentinfo')).toContainText('取り込み中')

  await pick(page, '/Users/me/Documents/Kura ライブラリ-2026-11-01.db')
  await page.getByRole('dialog', { name: '管理情報をインポート' }).getByRole('button', { name: 'インポート' }).click()
  await expect(page.getByRole('dialog', { name: '設定' })).toContainText(
    'エラー：取り込みか Finder での変更の反映が終わってから、もう一度選んでください',
  )
  expect(logs.filter((l) => l.startsWith('restore:'))).toEqual([])
})
