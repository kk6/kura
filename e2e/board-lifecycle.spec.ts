import { expect, test, type Page } from '@playwright/test'
import { boardWith, box, center, drag, emit, stored } from './board-helpers'

// 元画像の状態をボードの枠に出し、ギャラリーの画像へ移る（FR-104、FR-511、FR-701、FR-704）

// ギャラリーで画像の状態が変わったことにして、開いているボードに知らせる
async function change(page: Page, n: number, source: Record<string, unknown>) {
  await page.evaluate(
    ([n, source]) => {
      const data = JSON.parse(sessionStorage.getItem('mock.boards')!)
      Object.assign(data.boards[0].items[n].source, source)
      sessionStorage.setItem('mock.boards', JSON.stringify(data))
    },
    [n, source] as const,
  )
  await emit(page, 'images-changed')
}

const EDITS = ['左右反転', 'グレースケール', '右へ90度回転', 'トリミング']

test('開いたままのボードで、ゴミ箱・復元・完全削除が配置を保ったまま枠に出る。枠は動かせて外せるが、加工はできない', async ({
  page,
}) => {
  const { canvas, items } = await boardWith(page, 2)
  const before = await stored(page)
  const id = before.items[0].id
  const imageId = before.items[0].source.image_id
  const first = canvas.locator(`[data-id="${id}"]`)
  const place = await box(first)
  const menu = page.getByRole('menu')

  await change(page, 0, { status: 'trashed' })
  await expect(first).toHaveAccessibleName(/（ゴミ箱にあります）/)
  await expect(first.locator('img')).toHaveCount(0)
  expect(await box(first)).toEqual(place)
  await expect(items.nth(1).locator('img')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/board-trashed.png' })

  // 枠では加工できず、回転のハンドルも出ない。重なり順は変えられる
  await first.click({ button: 'right' })
  for (const name of EDITS) await expect(menu.getByText(name, { exact: true })).toBeDisabled()
  await expect(menu.getByText('最前面へ')).toBeEnabled()
  await expect(canvas.locator('[data-rotate]')).toHaveCount(0)
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await menu.getByText('ギャラリーで表示').click()
  await expect.poll(() => logs).toContain(`gallery: ${imageId}`)
  await expect(page.getByRole('main', { name: /キャンバス/ })).toBeVisible()

  // 枠を動かしてから元に戻すと、動かした先に画像が出る
  const from = center(place)
  await drag(page, from, { x: from.x + 40, y: from.y + 30 })
  await expect.poll(async () => (await stored(page)).items[0].geometry.x).not.toBe(before.items[0].geometry.x)
  await change(page, 0, { status: 'available' })
  await expect(first.locator('img')).toHaveCount(1)
  expect((await box(first)).x).toBeCloseTo(place.x + 40, 0)
  await first.click({ button: 'right' })
  await expect(menu.getByText('左右反転')).toBeEnabled()
  await page.keyboard.press('Escape')

  // 動かす前へ取り消しても、今の状態の枠になる。前の状態の画像を出さない
  await change(page, 0, { status: 'missing' })
  await expect(first).toHaveAccessibleName(/（見つからない）/)
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await box(first)).x).toBeCloseTo(place.x, 0)
  await expect(first).toHaveAccessibleName(/（見つからない）/)
  await expect(first.locator('img')).toHaveCount(0)

  // 完全に削除された画像は名前だけを残し、ギャラリーへは移れない。枠は外せる
  await change(page, 0, { status: 'deleted', image_id: null })
  await expect(first).toHaveAccessibleName(`${before.items[0].source.file_name}（削除された画像）`)
  await expect(first).toContainText(before.items[0].source.file_name)
  await first.click({ button: 'right' })
  await expect(menu.getByText('ギャラリーで表示')).toBeDisabled()
  await page.screenshot({ path: 'test-results/board-deleted.png' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Backspace')
  await expect(items).toHaveCount(1)
  await expect.poll(async () => (await stored(page)).items.map((i) => i.id)).toEqual([before.items[1].id])
})

test('複数を選んでいる間は「ギャラリーで表示」を押せない', async ({ page }) => {
  const { items } = await boardWith(page, 2)
  await items.nth(0).click()
  await items.nth(1).click({ modifiers: ['Meta'] })
  await items.nth(0).click({ button: 'right' })
  await expect(page.getByRole('menu').getByText('ギャラリーで表示')).toBeDisabled()
})

test('「ギャラリーで表示」を受けたギャラリーは、絞り込みを外して画像を選び、見える所へスクロールする。ゴミ箱と見つからない画像はその一覧で選ぶ', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('差分を反映')
  const search = page.getByRole('combobox', { name: '検索' })
  const list = page.getByRole('main', { name: '画像の一覧' })
  const selected = page.locator('.list__thumb--selected')

  // 絞り込みで隠れていて、一覧のずっと下にある画像
  await search.fill('ref_00001')
  await expect(page.locator('.list__thumb')).toHaveCount(1)
  await emit(page, 'gallery-reveal', 1500)
  await expect(search).toHaveValue('')
  await expect(selected).toHaveCount(1)
  await expect(selected).toHaveAttribute('data-id', '1500')
  await expect(selected).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText('ref_01500.jpg')
  await page.screenshot({ path: 'test-results/gallery-reveal.png' })

  // 確認のダイアログを出している間は、その下の選択を変えない
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ゴミ箱へ移す' }).click()
  await expect(status).toContainText('完了：ゴミ箱へ移した 1枚')
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /^ゴミ箱/ })
    .click()
  await page.locator('.list__thumb').first().click()
  const panel = page.getByRole('complementary', { name: 'ゴミ箱' })
  await panel.getByRole('button', { name: '完全に削除' }).click()
  await emit(page, 'gallery-reveal', 3)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')

  // ゴミ箱の画像はゴミ箱で、見つからない画像は「見つからない」で選ぶ
  await emit(page, 'gallery-reveal', 3)
  await expect(list.locator('.list__thumb--selected')).toHaveAttribute('data-id', '3')
  await expect(panel).toHaveCount(0)
  await emit(page, 'gallery-reveal', 1500)
  await expect(panel.getByRole('heading')).toHaveText('ref_01500.jpg')
  await expect(selected).toHaveAttribute('data-id', '1500')
  await emit(page, 'gallery-reveal', 2003)
  await expect(page.getByRole('complementary', { name: '見つからない' }).getByRole('heading')).toHaveText(
    'missing_1.jpg',
  )
  await expect(selected).toHaveAttribute('data-id', '2003')

  // もうない画像では、今の表示を変えずに知らせる
  await emit(page, 'gallery-reveal', 99999)
  await expect(status).toContainText('画像がギャラリーにありません')
  await expect(selected).toHaveAttribute('data-id', '2003')
})

test('低いウィンドウでも、右クリックのメニューはウィンドウに収まり、スクロールして最後の項目を押せる', async ({
  page,
}) => {
  const { items } = await boardWith(page, 1)
  const imageId = (await stored(page)).items[0].source.image_id
  await page.setViewportSize({ width: 900, height: 320 })
  const at = await box(items.first())
  await page.mouse.click(at.x + 10, Math.min(at.y + 10, 300), { button: 'right' })
  const menu = page.getByRole('menu')
  const shown = (await menu.boundingBox())!
  expect(shown.y).toBeGreaterThanOrEqual(0)
  expect(shown.y + shown.height).toBeLessThanOrEqual(320)

  await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2)
  await page.mouse.wheel(0, 1000)
  await expect(menu).toBeVisible()
  await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/board-menu-short.png' })
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await menu.getByText('ギャラリーで表示').click()
  await expect.poll(() => logs).toContain(`gallery: ${imageId}`)
})
