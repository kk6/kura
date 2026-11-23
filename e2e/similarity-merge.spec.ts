import { expect, test, type Page } from './fixtures'
import { thumbs } from './gallery-helpers'

// 「1枚にまとめる…」（FR-610）。モックは20枚。1枚目のタグは「あおり」「座り」、14枚目は「振り返り」、15枚目は「あおり」「座り」
// （src/mocks/ipc.ts の IMAGES）。ファイルサイズは id が大きいほど大きい（imageDetail）
const name = (id: number) => `ref_${String(id).padStart(5, '0')}.jpg`
const thumb = (page: Page, id: number) => thumbs(page).and(page.getByAltText(name(id), { exact: true }))
const detail = (page: Page) => page.getByRole('complementary', { name: '詳細' })
const dialog = (page: Page) => page.getByRole('dialog', { name: /1枚にまとめる/ })

async function openResults(page: Page) {
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
      }),
    )
  })
  await page.goto('/?images=20')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await thumb(page, 1).click()
  await detail(page).getByRole('button', { name: '似た画像を探す' }).click()
  await expect(page.locator('.gallery__toolbar')).toContainText('似た画像')
}

test('結果のモードの外と、1枚だけを選んだときは「1枚にまとめる…」を出さない', async ({ page }) => {
  await openResults(page)
  await thumb(page, 1).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'ゴミ箱へ移す' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '1枚にまとめる…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '閉じる', exact: true }).click()
  await thumb(page, 1).click()
  await thumb(page, 14).click({ modifiers: ['Meta'] })
  await expect(detail(page)).toContainText('2枚を選んでいます')
  await expect(detail(page).getByRole('button', { name: '1枚にまとめる…' })).toHaveCount(0)
  await thumb(page, 14).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '1枚にまとめる…' })).toHaveCount(0)
})

test('結果で3枚を選んでまとめると、1枚が残りほかはゴミ箱へ移って一覧から消える', async ({ page }) => {
  await openResults(page)
  for (const id of [14, 15]) await thumb(page, id).click({ modifiers: ['Meta'] })
  await expect(detail(page).getByRole('button', { name: '1枚にまとめる…' })).toBeVisible()
  await thumb(page, 15).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '1枚にまとめる…' })).toBeVisible()
  await page.screenshot({ path: 'test-results/merge-menu.png' })
  await page.getByRole('menuitem', { name: '1枚にまとめる…' }).click()

  const d = dialog(page)
  await expect(d.getByRole('heading')).toHaveText('3枚を1枚にまとめる')
  // 初期値は画素数の一番大きい画像。同じならファイルサイズの大きい方（id の大きい方）
  await expect(d.getByRole('radio', { checked: true })).toHaveCount(1)
  const sizes = await d
    .locator('.merge__image')
    .evaluateAll((labels) =>
      labels.map((l) => [
        Number(l.querySelector('.merge__name')!.textContent!.match(/\d+/)![0]),
        ...l.querySelector('.merge__meta')!.textContent!.split('×').map(Number),
      ]),
    )
  const best = sizes.sort((a, b) => b[1] * b[2] - a[1] * a[2] || b[0] - a[0])[0][0]
  await expect(d.getByRole('radio', { name: name(best) })).toBeChecked()
  // タグは3枚のタグを合わせたもの
  await expect(d.locator('.tag')).toHaveText(['あおり', '座り', '振り返り'])
  await page.screenshot({ path: 'test-results/merge-dialog.png' })

  await d.getByRole('radio', { name: name(1) }).check()
  await d.getByRole('button', { name: '振り返り を外す' }).click()
  await expect(d.locator('.tag')).toHaveText(['あおり', '座り'])
  await d.getByRole('combobox').click()
  await page.getByRole('option', { name: '背景' }).click()
  await d.getByRole('button', { name: 'まとめる…' }).click()
  await expect(d).toContainText(`「${name(1)}」を残し、ほかの2枚をゴミ箱へ移します`)
  await page.screenshot({ path: 'test-results/merge-confirm.png' })
  await d.getByRole('button', { name: 'ゴミ箱へ移す' }).click()

  await expect(d).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).toContainText('1枚にまとめ、ゴミ箱へ移した 2枚')
  await expect(thumb(page, 14)).toHaveCount(0)
  await expect(thumb(page, 15)).toHaveCount(0)
  await expect(thumb(page, 1)).toBeVisible()
  await expect(page.locator('#detail-category')).toHaveValue('背景')
  await page.screenshot({ path: 'test-results/merge-after.png' })
})
