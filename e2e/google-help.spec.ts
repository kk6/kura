import { expect, test } from './fixtures'
import { emit } from './board-helpers'
import { openGallery, thumb } from './gallery-helpers'

// Google 画像検索（FR-612）とヘルプ（NFR-14）。本物のブラウザとクリップボードとメニューバーは実アプリで確かめる。
// ここでは、Rust に頼む操作と、画面の表示を確かめる

test('元URLのある画像は Google レンズの URL での検索を開き、ない画像はコピーして ⌘V を促す（FR-612）', async ({
  page,
}) => {
  const opened: string[] = []
  page.on('console', (m) => /^(browser|clipboard):/.test(m.text()) && opened.push(...m.text().split('\n')))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })

  await thumb(page, 1).click({ button: 'right' })
  await page.screenshot({ path: 'test-results/context-menu-google.png' })
  await page.getByRole('menuitem', { name: 'Google 画像検索で探す' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect
    .poll(() => opened)
    .toEqual([
      `browser: https://lens.google.com/uploadbyurl?url=${encodeURIComponent('https://example.com/images/ref_00001.jpg')}`,
    ])
  await expect(page.getByRole('contentinfo')).not.toContainText('コピー')

  // 拡大表示の右クリックからも同じ。元URLのない画像はクリップボードに写す
  opened.length = 0
  await thumb(page, 2).dblclick()
  await page
    .getByRole('region', { name: '拡大表示' })
    .getByRole('img', { name: 'ref_00002.jpg' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Google 画像検索で探す' }).click()
  await expect.poll(() => opened).toEqual(['clipboard: 2', 'browser: https://lens.google.com/'])
  await expect(page.getByRole('contentinfo')).toContainText('画像をコピーしました。開いたページで ⌘V を押してください')
  await page.keyboard.press('Space')

  // メニューバーの項目は1枚を選んでいるときだけ効く。複数のときは何もしない
  opened.length = 0
  await emit(page, 'search-google')
  await expect.poll(() => opened).toEqual(['clipboard: 2', 'browser: https://lens.google.com/'])
  opened.length = 0
  await thumb(page, 3).click({ modifiers: ['Meta'] })
  await emit(page, 'search-google')
  await page.waitForTimeout(200)
  expect(opened).toEqual([])
})

test('メニューの設定…、検索、詳細パネル、ゴミ箱へ移すは、キーを押したときと同じ操作になる（6章）', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await thumb(page, 1).click()
  const detail = page.getByRole('complementary', { name: '詳細' })
  await expect(detail).toBeVisible()
  await emit(page, 'edit-menu', 'detail')
  await expect(detail).toHaveCount(0)
  await emit(page, 'edit-menu', 'detail')
  await expect(detail).toBeVisible()

  await emit(page, 'edit-menu', 'trash')
  await expect(page.getByRole('contentinfo')).toContainText('完了：ゴミ箱へ移した 1枚')
  await expect(thumb(page, 1)).toHaveCount(0)

  await emit(page, 'edit-menu', 'find')
  await expect(page.locator('#search')).toBeFocused()
  await emit(page, 'edit-menu', 'settings')
  await expect(page.getByRole('heading', { name: '一般' })).toBeVisible()
})

test('ヘルプのウインドウに docs/user-guide.md の見出しと画像を出し、目次から見出しへ移れる（NFR-14）', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // 外へ通信しないこと：アプリに入れたもの（開発サーバー）以外には頼まない
  const outside: string[] = []
  page.on('request', (r) => !r.url().startsWith('http://localhost:5173') && outside.push(r.url()))
  await page.goto('/?help')
  const help = page.getByRole('main', { name: 'Kura ヘルプ' })
  await expect(help.getByRole('heading', { level: 1 })).toHaveText('Kura ユーザーガイド')
  await expect(help.getByRole('heading', { name: 'キーボードショートカット' })).toBeVisible()
  const images = help.getByRole('img')
  await expect(images.first()).toBeVisible()
  await expect
    .poll(() => images.evaluateAll((imgs) => imgs.filter((i) => !(i as HTMLImageElement).naturalWidth).length))
    .toBe(0)
  await page.screenshot({ path: 'test-results/help.png' })

  await help.getByRole('link', { name: 'キーボードショートカット' }).click()
  await expect(page).toHaveURL(/#キーボードショートカット$|#%E3%82%AD/)
  await expect(help.getByRole('heading', { name: 'キーボードショートカット' })).toBeInViewport()
  await page.screenshot({ path: 'test-results/help-anchor.png' })

  // 外のページへのリンクは開かない（扱いが決まるまで）
  await help.getByRole('link', { name: 'Unsplash' }).click()
  await expect(help).toBeVisible()
  expect(outside).toEqual([])
  expect(errors).toEqual([])
})
