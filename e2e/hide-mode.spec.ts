import { expect, test } from './fixtures'
import { boardWith, box, emit, stored } from './board-helpers'
import { openGallery, thumb, thumbs } from './gallery-helpers'

// 隠す印と隠すモード（FR-513）。モードの切り替えは、メニューバーの「隠すモード」を選んだ後に Rust が送る hide-mode を真似る

test('隠す印を付けた画像は、隠すモードの間は一覧と件数から外れ、隠している枚数がステータスバーに出る', async ({
  page,
}) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const status = page.getByRole('contentinfo')
  const all = page.getByRole('navigation', { name: 'サイドバー' }).getByRole('button', { name: /すべての画像/ })
  const total = await thumbs(page).count()
  await expect(status).toContainText('2000枚')

  // 右クリックで1枚、詳細パネルでもう1枚に印を付ける
  await thumb(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'NSFWとしてマークする' }).click()
  await thumb(page, 3).click()
  const detail = page.getByRole('complementary', { name: '詳細' })
  await detail.getByRole('button', { name: 'NSFWとしてマークする' }).click()
  await expect(detail.getByRole('button', { name: '隠す印を外す' })).toBeVisible()
  await page.screenshot({ path: 'test-results/hide-before.png' })

  await emit(page, 'hide-mode', true)
  await expect(thumb(page, 2)).toHaveCount(0)
  await expect(thumb(page, 3)).toHaveCount(0)
  await expect(status).toContainText('1998枚 ・ 隠している画像 2枚')
  await expect(all).toContainText('1998')
  await expect(detail).toContainText('画像を選ぶと、ここに詳細が出ます')
  await page.screenshot({ path: 'test-results/hide-mode.png' })

  // モードを切ると戻り、印を外せる
  await emit(page, 'hide-mode', false)
  await expect(thumb(page, 2)).toHaveCount(1)
  await expect(status).toContainText('2000枚')
  await expect(status).not.toContainText('隠している画像')
  expect(await thumbs(page).count()).toBe(total)
  await thumb(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '隠す印を外す' }).click()
  await emit(page, 'hide-mode', true)
  await expect(thumb(page, 2)).toHaveCount(1)
  await expect(status).toContainText('1999枚 ・ 1枚を選択 ・ 隠している画像 1枚')
})

test('隠すモードの間、ボードの印の付いた画像は同じ位置と大きさの無地の箱になり、保存する配置は変わらない', async ({
  page,
}) => {
  const { canvas, items } = await boardWith(page, 2)
  const before = await stored(page)
  const first = canvas.locator(`[data-id="${before.items[0].id}"]`)
  const place = await box(first)
  // ギャラリーで1枚目に印を付けたことにする。開いているボードは images-changed で引き直す
  await page.evaluate(() => {
    const data = JSON.parse(sessionStorage.getItem('mock.boards')!)
    data.boards[0].items[0].source.hidden = true
    sessionStorage.setItem('mock.boards', JSON.stringify(data))
  })
  await emit(page, 'images-changed')
  await page.screenshot({ path: 'test-results/board-hide-before.png' })
  await expect(first.locator('img')).toHaveCount(1)

  await emit(page, 'hide-mode', true)
  await expect(first).toHaveAccessibleName('隠している画像')
  await expect(first.locator('img')).toHaveCount(0)
  await expect(first).not.toContainText(before.items[0].source.file_name)
  expect(await box(first)).toEqual(place)
  await expect(items.nth(1).locator('img')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/board-hide-mode.png' })

  await emit(page, 'hide-mode', false)
  await expect(first.locator('img')).toHaveCount(1)
  expect((await stored(page)).items.map((i) => i.geometry)).toEqual(before.items.map((i) => i.geometry))
})

test('隠すモードの間、印の付いた画像は似た画像を探した結果と元が同じ画像の組に出ない', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mock.settings')) return
    sessionStorage.setItem(
      'mock.settings',
      JSON.stringify({
        confirm_category_move: true,
        thumb_width: 200,
        tags_collapsed: false,
        board_enabled: true,
        similarity_enabled: true,
        similarity_weights: {},
        board_window: { always_on_top: false, opacity: 100, frame: null },
        hide_mode: false,
      }),
    )
  })
  await page.goto('/?images=20')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  const detail = page.getByRole('complementary', { name: '詳細' })

  // 2 に印を付けてから 1 で似た画像を探す。モックの組は 1〜2、3〜5、6〜7
  await thumb(page, 2).click()
  await detail.getByRole('button', { name: 'NSFWとしてマークする' }).click()
  await thumb(page, 1).click()
  await detail.getByRole('button', { name: '似た画像を探す' }).click()
  await expect(page.locator('.gallery__toolbar')).toContainText('閉じる')
  await expect(thumb(page, 2)).toHaveCount(1)
  await emit(page, 'hide-mode', true)
  await expect(thumb(page, 2)).toHaveCount(0)
  await expect(thumb(page, 3)).toHaveCount(1)
  await page.locator('.gallery__toolbar').getByRole('button', { name: '閉じる', exact: true }).click()

  // 1 と 2 の組は1枚になるので出さない
  await emit(page, 'find-origin-groups')
  await expect(page.locator('.list__section')).toHaveCount(2)
  await expect(thumb(page, 1)).toHaveCount(0)
  await expect(thumb(page, 2)).toHaveCount(0)
})
