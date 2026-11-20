import type { JSHandle, Locator, Page } from '@playwright/test'
import { boardWith, stored } from './board-helpers'
import { expect, test } from './fixtures'
import { openGallery, thumb } from './gallery-helpers'

const IMAGE_DRAG = 'application/x-kura-images'

// 一覧とボードは別のウィンドウなので、Playwright ではウィンドウをまたいで運べない。
// 一覧がつかんだときに入れるデータと、ボードが落とされたデータを受けたときの動きを、それぞれ確かめる
const transfer = (page: Page, data?: string) =>
  page.evaluateHandle(
    ([type, data]) => {
      const dt = new DataTransfer()
      if (data !== undefined) dt.setData(type, data)
      return dt
    },
    [IMAGE_DRAG, data] as const,
  )

async function dropOn(canvas: Locator, dataTransfer: JSHandle, at: { x: number; y: number }) {
  for (const type of ['dragenter', 'dragover', 'drop'])
    await canvas.dispatchEvent(type, { dataTransfer, clientX: at.x, clientY: at.y })
}

test('一覧から運んだ画像を落とした点に置いて選び、ドロップ1回を ⌘Z の1回で外し、保存する', async ({ page }) => {
  const { canvas, items, area } = await boardWith(page, 1)
  const before = (await stored(page)).items
  const selectedItems = canvas.locator('.board__item--selected')

  // 1枚なら、画像の中心が落とした点に来る
  const at = { x: area.x + area.width * 0.75, y: area.y + area.height * 0.6 }
  await dropOn(canvas, await transfer(page, JSON.stringify([5])), at)
  await expect(items).toHaveCount(2)
  await expect(selectedItems).toHaveCount(1)
  const b = (await selectedItems.boundingBox())!
  expect(Math.abs(b.x + b.width / 2 - at.x)).toBeLessThan(2)
  expect(Math.abs(b.y + b.height / 2 - at.y)).toBeLessThan(2)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const one = (await stored(page)).items

  // 複数ならまとめて置き、追加分だけを選ぶ
  await dropOn(canvas, await transfer(page, JSON.stringify([6, 7])), { x: area.x + 100, y: area.y + 100 })
  await expect(items).toHaveCount(4)
  await expect(selectedItems).toHaveCount(2)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const three = (await stored(page)).items
  expect(three.slice(0, 2)).toEqual(one)
  expect(three.slice(2).map((i) => i.source.image_id)).toEqual([6, 7])
  await page.screenshot({ path: 'test-results/board-drop.png' })

  await page.keyboard.press('Meta+z')
  await expect(items).toHaveCount(2)
  await expect.poll(async () => (await stored(page)).items).toEqual(one)
  await page.keyboard.press('Meta+z')
  await expect(items).toHaveCount(1)
  await expect.poll(async () => (await stored(page)).items).toEqual(before)
  await page.keyboard.press('Shift+Meta+z')
  await expect(items).toHaveCount(2)
  await expect.poll(async () => (await stored(page)).items).toEqual(one)
})

test('一覧から運んだのでないデータを落としても何も置かない', async ({ page }) => {
  const { canvas, items, area } = await boardWith(page, 1)
  const at = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
  for (const data of [undefined, 'abc', '[]', '["1"]']) await dropOn(canvas, await transfer(page, data), at)
  await expect(items).toHaveCount(1)
  expect((await stored(page)).items).toHaveLength(1)
})

test('一覧でつかむと選んだ画像を一覧の順で運び、選んでいない画像はそれだけを選んで運ぶ。ゴミ箱ではつかめない', async ({
  page,
}) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const id = async (n: number) => Number(await thumb(page, n).getAttribute('data-id'))
  const grab = async (target: Locator) => {
    const dt = await transfer(page)
    await target.dispatchEvent('dragstart', { dataTransfer: dt })
    return dt.evaluate((dt, type) => dt.getData(type), IMAGE_DRAG)
  }

  await thumb(page, 3).click()
  await thumb(page, 1).click({ modifiers: ['Meta'] })
  expect(JSON.parse(await grab(thumb(page, 3)))).toEqual([await id(1), await id(3)])

  expect(JSON.parse(await grab(thumb(page, 5)))).toEqual([await id(5)])
  await expect(page.getByRole('contentinfo')).toContainText('1枚を選択')

  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /^ゴミ箱/ })
    .click()
  const trashed = page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first()
  await trashed.evaluate((el) =>
    el.addEventListener('dragstart', (e) => setTimeout(() => (el.dataset.prevented = String(e.defaultPrevented))), {
      once: true,
    }),
  )
  expect(await grab(trashed)).toBe('')
  await expect(trashed).toHaveAttribute('data-prevented', 'true')
})
