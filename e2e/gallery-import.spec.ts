import { expect, test } from './fixtures'
import { openGallery, type TauriWindow } from './gallery-helpers'

test('フォルダを取り込むと、ステータスバーに進み具合と結果を出し、スキップの一覧を開ける', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await page.getByRole('button', { name: 'フォルダを取り込む' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('取り込み中 240 / 481枚')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '240')
  // 取り込み中はボタンの代わりに処理中であることを出し、終わるとボタンに戻す
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('取り込み中…')
  await page.screenshot({ path: 'test-results/import-progress.png' })

  await expect(status).toContainText('完了：取り込み 477枚')
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toBeEnabled()
  await expect(status).toContainText('完了：未分類から移した 3枚')
  await expect(status.getByRole('button', { name: '注意：スキップ 3枚' })).toBeVisible()
  await status.getByRole('button', { name: 'エラー：取り込めない 1件' }).click()

  const dialog = page.getByRole('dialog', { name: '取り込まなかったファイル（4件）' })
  await expect(dialog.getByRole('listitem')).toHaveCount(4)
  await expect(dialog).toContainText('注意：同じ画像がライブラリ（ゴミ箱を含む）にあります')
  await expect(dialog).toContainText('注意：対応していない形式です')
  await expect(dialog).toContainText('エラー：取り込めませんでした（画像を読めません')
  await page.screenshot({ path: 'test-results/import-skipped.png' })
  await page.keyboard.press('Escape')

  // 取り込めたが元URLを全部は保存できなかった画像は、スキップとは別に数えて一覧を出す（FR-208）
  await status.getByRole('button', { name: '注意：元URLの注意 2件' }).click()
  const notes = page.getByRole('dialog', { name: '元URLの注意（2枚）' })
  await expect(notes.getByRole('listitem')).toHaveCount(2)
  await expect(notes).toContainText('ref_00020.jpg')
  await expect(notes).toContainText('注意：ダウンロード元の記録を解析できません')
  await expect(notes).toContainText('注意：ダウンロード元の記録の画像URLが不正なため、掲載ページURLだけを保存しました')

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
