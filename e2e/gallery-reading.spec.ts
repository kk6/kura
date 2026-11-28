import { expect, test } from './fixtures'
import { openGallery, thumb } from './gallery-helpers'

// 読み仮名とローマ字での検索（FR-418）。モックの「座り」はカテゴリとタグの両方に読み仮名「すわり」を持つ
test('読み仮名を付けた「座り」が、ローマ字・ひらがな・カタカナで検索バーと詳細パネルの候補に出る', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const search = page.getByRole('combobox', { name: '検索' })
  const options = page.getByRole('listbox', { name: '絞り込みの候補' }).getByRole('option')

  for (const typed of ['suwari', 'すわり', 'スワリ', 'suwar']) {
    await search.fill(typed)
    await expect(options).toHaveText(['カテゴリポーズ / 座り', 'タグ座り'])
  }
  await search.fill('suwari')
  await page.screenshot({ path: 'test-results/reading-search.png' })
  await search.press('Escape')

  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await thumb(page, 2).click()
  const detail = page.getByRole('complementary', { name: '詳細' })
  const tagInput = detail.getByRole('combobox', { name: 'タグ' })
  await tagInput.fill('suwari')
  await expect(detail.getByRole('listbox').getByRole('option')).toContainText(['座り'])
  await page.screenshot({ path: 'test-results/reading-detail-tag.png' })
  await tagInput.press('Escape')
  const category = detail.getByRole('combobox', { name: 'カテゴリ' })
  await category.click()
  await category.fill('suwari')
  await expect(detail.getByRole('listbox').getByRole('option')).toHaveText(['ポーズ / 座り'])
  expect(errors).toEqual([])
})

test('カテゴリの読み仮名を名前と並べて変え、タグの読み仮名をサイドバーと設定の「タグ」で変える', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const menu = page.getByRole('menu')
  const search = page.getByRole('combobox', { name: '検索' })
  const options = page.getByRole('listbox', { name: '絞り込みの候補' }).getByRole('option')

  // カテゴリ：名前と読み仮名の欄が並ぶ。カタカナで入れてもひらがなで残る
  await sidebar.locator('.sidebar__item--category').getByText('背景', { exact: true }).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '名前と読み仮名を変更…' }).click()
  const reading = sidebar.getByRole('textbox', { name: '読み仮名' })
  await expect(sidebar.getByRole('textbox', { name: 'カテゴリ名' })).toHaveValue('背景')
  await expect(reading).toHaveValue('')
  await reading.fill('ハイケイ')
  await page.screenshot({ path: 'test-results/reading-category.png' })
  await reading.press('Enter')
  await expect(reading).toHaveCount(0)
  await search.fill('haikei')
  await expect(options).toHaveText(['カテゴリ背景'])
  await search.press('Escape')
  // ダブルクリックは名前だけを変える
  await sidebar.locator('.sidebar__item--category').getByText('背景', { exact: true }).dblclick()
  await expect(reading).toHaveCount(0)
  await page.keyboard.press('Escape')
  await sidebar.locator('.sidebar__item--category').getByText('背景', { exact: true }).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '名前と読み仮名を変更…' }).click()
  await expect(reading).toHaveValue('はいけい')
  await page.keyboard.press('Escape')

  // タグ：サイドバーの右クリック
  const sideTags = sidebar.getByRole('list', { name: 'タグ' })
  await sideTags.getByRole('button', { name: /^振り返り/ }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['読み仮名を変更…'])
  await menu.getByRole('menuitem', { name: '読み仮名を変更…' }).click()
  const tagReading = sidebar.getByRole('textbox', { name: '「振り返り」の読み仮名' })
  await tagReading.fill('ふりかえり')
  await page.screenshot({ path: 'test-results/reading-sidebar-tag.png' })
  await tagReading.press('Enter')
  await expect(tagReading).toHaveCount(0)
  await sidebar.getByRole('searchbox', { name: 'タグを名前で絞り込む' }).fill('furikaeri')
  await expect(sideTags.locator('.sidebar__name')).toHaveText(['振り返り'])

  // タグ：設定の「タグ」の行。読み仮名のないカタカナの名前もローマ字で出る
  await sidebar.getByRole('button', { name: 'タグを管理する' }).click()
  const settings = page.getByRole('region', { name: '設定' })
  const rows = settings.getByRole('list', { name: 'タグ' }).locator('.tags__name')
  await settings.getByRole('button', { name: '「あおり」の名前を変える' }).click()
  await settings.getByRole('textbox', { name: '「あおり」の新しい名前' }).fill('スワリ')
  await settings.getByRole('textbox', { name: '「あおり」の新しい名前' }).press('Enter')
  await settings.getByRole('button', { name: '「振り返り」の読み仮名を変える' }).click()
  await expect(settings.getByRole('textbox', { name: '「振り返り」の読み仮名' })).toHaveValue('ふりかえり')
  await page.screenshot({ path: 'test-results/reading-tag-manager.png' })
  await settings.getByRole('textbox', { name: '「振り返り」の読み仮名' }).press('Escape')
  await settings.getByRole('searchbox', { name: 'タグを名前で絞り込む' }).fill('suwari')
  await expect(rows).toHaveText(['スワリ', '座り'])
  expect(errors).toEqual([])
})
