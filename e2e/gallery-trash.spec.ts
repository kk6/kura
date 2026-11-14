import { expect, test } from './fixtures'
import { openGallery, thumbs, thumb } from './gallery-helpers'

test('選んだ画像をゴミ箱へ移し、ゴミ箱で元に戻し、確かめてから空にする', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const trashItem = sidebar.getByRole('button', { name: /^ゴミ箱/ })
  const status = page.getByRole('contentinfo')
  const all = sidebar.getByRole('button', { name: /^すべての画像/ })
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await expect(trashItem).toContainText('2')

  // 確認は出さずに移す。移せない画像（モックの ref_00007）は件数を出し、押すと一覧を開く
  await thumb(page, 1).click()
  await thumb(page, 2).click({ modifiers: ['Meta'] })
  await thumb(page, 7).click({ modifiers: ['Meta'] })
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ゴミ箱へ移す' }).click()
  await expect(status).toContainText('完了：ゴミ箱へ移した 2枚')
  await expect(status).toContainText('1998枚')
  await expect(thumb(page, 1)).toHaveCount(0)
  await expect(trashItem).toContainText('4')
  await expect(all).toContainText('1998')
  await status.getByRole('button', { name: /移せない 1枚/ }).click()
  await expect(page.getByRole('dialog', { name: '移せなかった画像（1枚）' })).toContainText('ref_00007.jpg')
  await page.keyboard.press('Escape')

  // ゴミ箱を開くと一覧がゴミ箱の画像になり、拡大表示はしない
  await trashItem.click()
  await expect(trashItem).toHaveAttribute('aria-current', 'true')
  await expect(all).toHaveAttribute('aria-current', 'false')
  await expect(thumbs(page)).toHaveCount(4)
  await expect(status).toContainText('ゴミ箱 4枚')
  const panel = page.getByRole('complementary', { name: 'ゴミ箱' })
  await expect(panel.getByRole('button', { name: '元に戻す' })).toBeDisabled()
  await thumb(page, 1).dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  // 1枚だけ選んでいるときは、どの画像かをファイル名で出す
  await expect(panel.getByRole('heading')).toHaveText((await thumb(page, 1).getAttribute('alt'))!)
  await page.screenshot({ path: 'test-results/trash.png' })

  // 元のカテゴリが消えた画像は未分類に戻して知らせる
  await page
    .getByRole('main', { name: '画像の一覧' })
    .getByAltText('deleted_1.jpg')
    .click({ modifiers: ['Meta'] })
  await expect(panel).toContainText('2枚を選んでいます')
  await panel.getByRole('button', { name: '元に戻す' }).click()
  await expect(status).toContainText('完了：元に戻した 2枚')
  await expect(status).toContainText('お知らせ：元のカテゴリがないため未分類に戻した 1枚')
  await expect(thumbs(page)).toHaveCount(2)
  await expect(trashItem).toContainText('2')
  await expect(all).toContainText('2000')
  await page.screenshot({ path: 'test-results/trash-restored.png' })

  // 選んだ画像だけを完全に削除する。取り消せないので枚数を見せて確かめる
  await trashItem.click()
  const first = page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first()
  await first.click()
  await panel.getByRole('button', { name: '完全に削除' }).click()
  const purgeDialog = page.getByRole('dialog', { name: '選んだ画像を完全に削除する' })
  // 1枚だけのときは、どの画像かをファイル名で出す
  await expect(purgeDialog).toContainText(`「${await first.getAttribute('alt')}」を完全に削除します。元に戻せません。`)
  await page.screenshot({ path: 'test-results/trash-purge-confirm.png' })
  await purgeDialog.getByRole('button', { name: '削除する' }).click()
  await expect(status).toContainText('完了：ゴミ箱から削除した 1枚')
  await expect(thumbs(page)).toHaveCount(1)
  await expect(trashItem).toContainText('1')

  // 空にするのは取り消せないので、枚数を見せて確かめる。Enter だけでは空にしない
  await panel.getByRole('button', { name: 'ゴミ箱を空にする' }).click()
  const dialog = page.getByRole('dialog', { name: 'ゴミ箱を空にする' })
  await expect(dialog).toContainText('ゴミ箱の画像 1枚を完全に削除します。元に戻せません。')
  await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeFocused()
  await page.screenshot({ path: 'test-results/trash-empty-confirm.png' })
  await page.keyboard.press('Enter')
  await expect(thumbs(page)).toHaveCount(1)
  await panel.getByRole('button', { name: 'ゴミ箱を空にする' }).click()
  await dialog.getByRole('button', { name: '空にする' }).click()
  await expect(status).toContainText('完了：ゴミ箱から削除した 1枚')
  await expect(thumbs(page)).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'ゴミ箱を空にする' })).toBeDisabled()

  // ほかの場所を押すとゴミ箱を閉じる
  await all.click()
  await expect(page.getByRole('complementary', { name: '詳細' })).toBeVisible()
  await expect(thumb(page, 1)).toBeVisible()
  expect(errors).toEqual([])
})

test('選んでいた「見つからない」の画像が差分確認で戻ると、その一覧での選択を外す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('注意：見つからない画像 2枚')
  await sidebar.getByRole('button', { name: /^見つからない/ }).click()
  const panel = page.getByRole('complementary', { name: '見つからない画像' })
  await page.getByRole('main', { name: '画像の一覧' }).getByAltText('missing_1.jpg').click()
  await expect(panel.getByRole('heading')).toHaveText('missing_1.jpg')

  await page.evaluate(() => sessionStorage.setItem('mock.returnMissing', '1'))
  await sidebar.getByRole('button', { name: '差分を確認' }).click()
  await expect(thumbs(page)).toHaveCount(1)
  await expect(panel.getByRole('heading')).toHaveText('見つからない画像')
})

test('開いた後に差分を確認して結果を出し、見つからない画像を開いて確かめてから一覧から外す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const missingItem = sidebar.getByRole('button', { name: /^見つからない/ })

  // 一覧を先に出してから差分を検出し、その間は進み具合を出して取り込みのボタンを止める
  await expect(status).toContainText('Finder での変更を反映中 2 / 4枚')
  await expect(status.getByRole('progressbar', { name: 'Finder での変更を反映する進み具合' })).toBeVisible()
  await expect(thumbs(page).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'フォルダを取り込む' })).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Finder での変更を反映中…')
  await page.screenshot({ path: 'test-results/scan-progress.png' })

  // 開いた後の差分検出の結果は、変わったものだけをステータスバーに出す
  await expect(status).toContainText('完了：差分を反映（登録 3枚、移動 1枚、カテゴリ追加 1件）')
  await expect(status).toContainText('注意：見つからない画像 2枚')
  await expect(missingItem).toContainText('2')
  await status.getByRole('button', { name: /スキップ 1枚/ }).click()
  await expect(page.getByRole('dialog', { name: '登録しなかったファイル（1件）' })).toContainText('メモ.txt')
  await page.keyboard.press('Escape')
  await status.getByRole('button', { name: '注意：元URLの注意 1件' }).click()
  await expect(page.getByRole('dialog', { name: '元URLの注意（1枚）' })).toContainText(
    '注意：ダウンロード元の記録に、保存できるURLがありません',
  )
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'test-results/scan.png' })

  // 見つからない画像は一覧が変わり、拡大表示はしない
  await missingItem.click()
  await expect(missingItem).toHaveAttribute('aria-current', 'true')
  await expect(thumbs(page)).toHaveCount(2)
  await expect(status).toContainText('見つからない 2枚')
  const panel = page.getByRole('complementary', { name: '見つからない画像' })
  await expect(panel.getByRole('button', { name: '一覧から外す' })).toBeDisabled()
  await page.getByRole('main', { name: '画像の一覧' }).getByAltText('missing_1.jpg').dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  await expect(panel.getByRole('heading')).toHaveText('missing_1.jpg')
  await page.screenshot({ path: 'test-results/missing.png' })

  // 外すのは取り消せないので、枚数を見せて確かめる
  await panel.getByRole('button', { name: '一覧から外す' }).click()
  const dialog = page.getByRole('dialog', { name: '選んだ画像を一覧から外す' })
  await expect(dialog).toContainText('「missing_1.jpg」のタグ、メモ、評価を削除します。元に戻せません。')
  await page.screenshot({ path: 'test-results/missing-confirm.png' })
  await dialog.getByRole('button', { name: '外す' }).click()
  await expect(status).toContainText('完了：一覧から外した 1枚')
  await expect(thumbs(page)).toHaveCount(1)
  await expect(missingItem).toContainText('1')

  // 手動の差分検出。押すと同じく結果を出す
  await sidebar.getByRole('button', { name: '差分を確認' }).click()
  await expect(status).toContainText('完了：差分を反映')
  expect(errors).toEqual([])
})
