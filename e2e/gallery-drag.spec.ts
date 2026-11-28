import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { openGallery, selectedNames, thumb, type TauriWindow } from './gallery-helpers'

const list = (page: Page) => page.getByRole('main', { name: '画像の一覧' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'サイドバー' })

// Tauri のドラッグのイベントを送る。ページの中の画像のドラッグは paths が空で、over と leave は paths を持たない
const tauriDrag = (page: Page, event: 'enter' | 'over' | 'drop' | 'leave', at?: { x: number; y: number }) =>
  page.evaluate(
    ([event, at]) =>
      (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
        event: `tauri://drag-${event}`,
        payload: event === 'enter' || event === 'drop' ? { paths: [], position: at } : { position: at },
      }),
    [event, at] as const,
  )

async function center(locator: import('@playwright/test').Locator) {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// 画像をつかんでサイドバーの target へ運び、離す。shot があれば離す前に撮る
async function carry(
  page: Page,
  from: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
  shot?: string,
) {
  await from.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) })
  const at = await center(target)
  await tauriDrag(page, 'enter', at)
  await tauriDrag(page, 'over', at)
  await expect(target).toHaveClass(/sidebar__item--drop/)
  if (shot) await page.screenshot({ path: shot })
  await tauriDrag(page, 'drop', at)
  await expect(target).not.toHaveClass(/sidebar__item--drop/)
}

test('画像のない所からドラッグして囲んだ画像を選び、⌘ か Shift を押していれば今の選択に足す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })

  // 一覧の左上の間隔から、先頭の2列の2段目にかかる所まで囲む
  const box = (await list(page).boundingBox())!
  const first = (await thumb(page, 1).boundingBox())!
  const start = { x: box.x + 2, y: box.y + 2 }
  const end = { x: first.x + first.width * 1.5, y: first.y + first.height + 20 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 5 })
  await expect(page.locator('.list__band')).toBeVisible()
  await page.screenshot({ path: 'test-results/marquee-dragging.png' })
  await page.mouse.up()
  await expect(page.locator('.list__band')).toHaveCount(0)

  // 囲んだ範囲にかかる画像を選び、離した後のクリックで選択を外さない
  const picked = await selectedNames(page)
  expect(picked.length).toBeGreaterThanOrEqual(3)
  expect(picked).toContain('ref_00001.jpg')
  await page.screenshot({ path: 'test-results/marquee-selected.png' })

  // 修飾キーなしで囲み直すと、前の選択は外す
  await thumb(page, 20).click()
  expect(await selectedNames(page)).toEqual(['ref_00020.jpg'])
  await list(page).evaluate((el) => (el.scrollTop = 0))
  for (const modifier of ['Meta', 'Shift'] as const) {
    await page.keyboard.down(modifier)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up(modifier)
    expect(await selectedNames(page)).toEqual([...picked, 'ref_00020.jpg'].sort())
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 5 })
  await page.mouse.up()
  expect(await selectedNames(page)).toEqual(picked)

  // 動かさずに押して離すと、今までどおり選択を外す
  await page.mouse.click(start.x, start.y)
  expect(await selectedNames(page)).toEqual([])
  expect(errors).toEqual([])
})

test('選んだ画像をサイドバーのカテゴリと未分類へ落とすとカテゴリを変え、タグへ落とすとタグを付ける', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const status = page.getByRole('contentinfo')

  await thumb(page, 2).click()
  await thumb(page, 4).click({ modifiers: ['Shift'] })
  const category = sidebar(page).locator('[data-classify^="category:"]').filter({ hasText: '背景' }).first()
  await carry(page, thumb(page, 3), category, 'test-results/drag-to-sidebar.png')
  await expect(status).toContainText('カテゴリを変更 3枚')
  await expect(detail.getByRole('combobox', { name: 'カテゴリ' })).toHaveValue(/背景/)

  const tag = sidebar(page).locator('.sidebar__tag').filter({ hasText: 'あおり' })
  await carry(page, thumb(page, 2), tag)
  await expect(detail.locator('.tag')).toHaveText(['あおり'])

  await carry(page, thumb(page, 4), sidebar(page).getByRole('button', { name: /^未分類/ }))
  await expect(status).toContainText('カテゴリを変更 3枚')
  await expect(detail.getByRole('combobox', { name: 'カテゴリ' })).toHaveValue('未分類')

  // スマートフォルダとゴミ箱は落とし先にしない。落としても何も変えない
  const trash = sidebar(page).getByRole('button', { name: /^ゴミ箱/ })
  const trashed = await trash.textContent()
  await thumb(page, 2).dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) })
  await tauriDrag(page, 'enter', await center(trash))
  await tauriDrag(page, 'drop', await center(trash))
  await expect(detail.getByRole('heading')).toHaveText('3枚を選んでいます')
  await expect(trash).toHaveText(trashed!)
  expect(errors).toEqual([])
})
