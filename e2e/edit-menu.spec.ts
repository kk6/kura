import { expect, test } from './fixtures'
import { boardWith, box, center, drag, emit, selectedIds, stored } from './board-helpers'

// メニューの「編集」の取り消す・やり直す・すべてを選択を、手前のウィンドウに効かせる（FR-702、NFR-12）。
// 本物では Rust が手前のウィンドウへ edit-menu を送る。モックには手前のウィンドウがないので、e2e が送る

test('ボードでは、メニューの取り消す・やり直す・すべてを選択が配置に効く', async ({ page }) => {
  const { canvas, items } = await boardWith(page, 2)
  const added = (await stored(page)).items
  const from = center(await box(items.nth(0)))
  await drag(page, from, { x: from.x + 40, y: from.y + 20 })
  await expect.poll(async () => (await stored(page)).items[0].geometry.x).toBeGreaterThan(added[0].geometry.x)
  const moved = (await stored(page)).items

  await emit(page, 'edit-menu', 'undo')
  await expect.poll(async () => (await stored(page)).items).toEqual(added)
  await emit(page, 'edit-menu', 'redo')
  await expect.poll(async () => (await stored(page)).items).toEqual(moved)

  await page.mouse.click((await canvas.boundingBox())!.x + 10, (await canvas.boundingBox())!.y + 10)
  await emit(page, 'edit-menu', 'select-all')
  await expect.poll(() => selectedIds(canvas)).toEqual(added.map((i) => i.id))
})

test('ギャラリーでは、すべてを選択が一覧の画像に効き、入力欄では文字だけに効く。ダイアログの間を Rust に知らせる', async ({
  page,
}) => {
  const reports: string[] = []
  page.on('console', (m) => m.text().startsWith('report_gallery') && reports.push(m.text()))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  const thumbs = page.locator('.list__thumb')
  const selected = page.locator('.list__thumb--selected')
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: false false')

  await emit(page, 'edit-menu', 'select-all')
  await expect(selected).toHaveCount(await thumbs.count())
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: true false')

  await thumbs.nth(0).click()
  await expect(selected).toHaveCount(1)
  const memo = page.locator('#detail-memo')
  await memo.click()
  await page.keyboard.type('メモ')
  await emit(page, 'edit-menu', 'select-all')
  await expect
    .poll(() => memo.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 2])
  await expect(selected).toHaveCount(1)
  await emit(page, 'edit-menu', 'undo')
  await expect(memo).toHaveValue('')
  await expect(selected).toHaveCount(1)

  await page.keyboard.press('Meta+,')
  await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible()
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: true true')
  await page.keyboard.press('Escape')
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: true false')
})
