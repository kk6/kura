import { expect, test } from './fixtures'
import { openGallery } from './gallery-helpers'

test('差分検出のスキップの一覧から、重複を整理し、対応していない形式のファイルを _未対応ファイル/ へ移す', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('完了：差分を反映')
  await status.getByRole('button', { name: /スキップ 3枚/ }).click()
  // 行を整理すると件数が変わるので、見出しの件数は別に確かめる
  const list = page.getByRole('dialog', { name: /^登録しなかったファイル/ })
  await expect(list.getByRole('heading')).toHaveText('登録しなかったファイル（3件）')
  const moveAll = list.getByRole('button', { name: '対応していない形式のファイルを _未対応ファイル/ へ移す（2件）' })
  await expect(list.getByRole('button', { name: '整理…' })).toHaveCount(1)
  await expect(moveAll).toBeVisible()
  await page.screenshot({ path: 'test-results/skipped.png' })

  // 重複の行の「整理…」で、残す場所を選ぶ。初期値は登録済みの画像の場所
  await list.getByRole('button', { name: '整理…' }).click()
  const tidy = page.getByRole('dialog', { name: '重複を整理する' })
  await expect(tidy.getByRole('radio', { name: /登録済みの画像の場所に残す/ })).toBeChecked()
  await expect(tidy).toContainText('_未分類/ref_00001.jpg')
  await expect(tidy).toContainText('ポーズ/座り/ref_00001 のコピー.jpg')
  await page.screenshot({ path: 'test-results/tidy.png' })
  await tidy.getByRole('radio', { name: /このファイルの場所に残す/ }).check()
  await tidy.getByRole('button', { name: '整理する' }).click()
  await expect(tidy).toHaveCount(0)
  await expect(list.getByRole('heading')).toHaveText('登録しなかったファイル（2件）')
  await expect(list.getByRole('button', { name: '整理…' })).toHaveCount(0)

  // 対応していない形式のファイルをまとめて移すと、行が移した先の知らせに変わる
  await moveAll.click()
  await expect(list).toContainText('完了：_未対応ファイル/ へ移した 2件')
  await expect(list.getByText('対応していない形式なので、_未対応ファイル/ へ移しました')).toHaveCount(2)
  await expect(moveAll).toHaveCount(0)
  await page.screenshot({ path: 'test-results/skipped-set-aside.png' })
  expect(errors).toEqual([])
})

test('設定で ON にすると、差分検出のたびに対応していない形式のファイルを移し、開き直しても ON のまま', async ({
  page,
}) => {
  await openGallery(page)
  const settings = page.getByRole('region', { name: '設定' })
  const name = '差分検出で、対応していない形式のファイルを _未対応ファイル/ へ移す'
  await page.getByRole('button', { name: '設定' }).click()
  await expect(settings.getByRole('switch', { name })).not.toBeChecked()
  await settings.getByRole('switch', { name }).check()
  await page.screenshot({ path: 'test-results/settings-set-aside.png' })
  await page.keyboard.press('Escape')

  await openGallery(page)
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('完了：差分を反映')
  await status.getByRole('button', { name: /スキップ 3枚/ }).click()
  const list = page.getByRole('dialog', { name: '登録しなかったファイル（3件）' })
  await expect(list).toContainText('完了：_未対応ファイル/ へ移した 2件')
  await expect(list.getByRole('button', { name: /_未対応ファイル\/ へ移す/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '設定' }).click()
  await expect(settings.getByRole('switch', { name })).toBeChecked()
})
