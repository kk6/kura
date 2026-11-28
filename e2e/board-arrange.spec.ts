import { expect, test, type Page } from './fixtures'
import { boardWith, selectedIds, stored } from './board-helpers'

// ボードの整列（FR-709）

const items = async (page: Page) => (await stored(page)).items
// 回していない配置の、ボード上の高さ
const heights = async (page: Page) =>
  (await items(page)).map((i) => Math.round(i.geometry.height * i.geometry.scale * 1000) / 1000)

test('選んでいなければすべてを高さをそろえて並べ、⌘Z で1回で戻り、⇧⌘Z でやり直す。開き直しても残る', async ({
  page,
}) => {
  const { canvas } = await boardWith(page, 4)
  const before = await items(page)
  expect(new Set(await heights(page)).size).toBeGreaterThan(1)
  await page.screenshot({ path: 'test-results/board-arrange-before.png' })

  await page.getByRole('button', { name: '整列', exact: true }).click()
  await expect.poll(async () => new Set(await heights(page)).size).toBe(1)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const arranged = await items(page)
  await page.screenshot({ path: 'test-results/board-arrange-after.png' })

  await page.keyboard.press('Meta+z')
  await expect.poll(() => items(page)).toEqual(before)
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(() => items(page)).toEqual(arranged)
  await expect(page.getByRole('status')).toHaveText('保存済み')

  await page.goto('/?board')
  await expect(canvas.getByRole('img')).toHaveCount(4)
  expect(await items(page)).toEqual(arranged)
})

test('右クリックの「整列」は、選んだ配置だけを並べる', async ({ page }) => {
  const { canvas, items: shown } = await boardWith(page, 3)
  const before = await items(page)
  await shown.nth(0).click()
  await shown.nth(1).click({ modifiers: ['Meta'] })
  await shown.nth(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '整列' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const picked = await selectedIds(canvas)
  expect(picked).toHaveLength(2)
  const pickedHeights = async () =>
    new Set(
      (await items(page))
        .filter((i) => picked.includes(i.id))
        .map((i) => Math.round(i.geometry.height * i.geometry.scale * 1000)),
    ).size
  await expect.poll(pickedHeights).toBe(1)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const untouched = (await items(page)).find((i) => !picked.includes(i.id))!
  expect(untouched).toEqual(before.find((i) => i.id === untouched.id))
})
