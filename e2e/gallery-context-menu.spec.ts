import { expect, test } from './fixtures'
import { openGallery, thumb, thumbs } from './gallery-helpers'

const menuItems = (page: import('@playwright/test').Page) => page.getByRole('menu').getByRole('menuitem')

test('一覧と拡大表示の右クリックで同じメニューが出て、拡大表示でも WebKit の標準のメニューを出さない', async ({
  page,
}) => {
  const finder: string[] = []
  page.on('console', (m) => m.text().startsWith('finder:') && finder.push(m.text()))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })

  await thumb(page, 2).click({ button: 'right' })
  const expected = [
    'ボードに追加…',
    'カテゴリを変える…',
    '1つ上のカテゴリへ移す',
    'Finderで表示',
    'Google 画像検索で探す',
    'NSFWとしてマークする',
    'ゴミ箱へ移す',
  ]
  await expect(menuItems(page)).toHaveText(expected)
  await page.screenshot({ path: 'test-results/context-menu.png' })
  await page.getByRole('menuitem', { name: 'Finderで表示' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(finder).toEqual(['finder: 2'])

  // 拡大表示の画像の上でも同じ項目。既定の動き（標準のメニュー）は止める
  await thumb(page, 3).dblclick()
  const zoom = page.getByRole('region', { name: '拡大表示' })
  const prevented = zoom.evaluate(
    (el) =>
      new Promise<boolean>((resolve) =>
        el.addEventListener('contextmenu', (e) => setTimeout(() => resolve(e.defaultPrevented)), { once: true }),
      ),
  )
  await zoom.getByRole('img', { name: 'ref_00003.jpg' }).click({ button: 'right' })
  expect(await prevented).toBe(true)
  await expect(menuItems(page)).toHaveText(expected)
  await page.screenshot({ path: 'test-results/zoom-context-menu.png' })

  // 押すと詳細パネルのボタンと同じ結果になる
  await page.getByRole('menuitem', { name: 'ゴミ箱へ移す' }).click()
  await expect(page.getByRole('contentinfo')).toContainText('完了：ゴミ箱へ移した 1枚')
  await expect(thumb(page, 3)).toHaveCount(0)
})

test('複数を選んで右クリックすると、選んだ画像すべてに効き、1枚にしか効かない項目は出さない', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await thumb(page, 1).click()
  await thumb(page, 2).click({ modifiers: ['Meta'] })
  await thumb(page, 2).click({ button: 'right' })
  await expect(menuItems(page)).toHaveText([
    'ボードに追加…',
    'カテゴリを変える…',
    '1つ上のカテゴリへ移す',
    'NSFWとしてマークする',
    'ゴミ箱へ移す',
  ])
  await page.getByRole('menuitem', { name: 'ゴミ箱へ移す' }).click()
  await expect(page.getByRole('contentinfo')).toContainText('完了：ゴミ箱へ移した 2枚')
})

test('ゴミ箱と見つからない画像では、その画面の操作だけが出て、元に戻せない操作は確かめてから行う', async ({ page }) => {
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  // 詳細パネルを閉じていても、右クリックから確認が出る
  await page.keyboard.press('Meta+i')
  await expect(page.getByRole('complementary', { name: '詳細' })).toHaveCount(0)

  await sidebar.getByRole('button', { name: /^ゴミ箱/ }).click()
  await expect(thumbs(page)).toHaveCount(2)
  await thumbs(page).first().click({ button: 'right' })
  await expect(menuItems(page)).toHaveText(['元に戻す', '完全に削除…'])
  await page.getByRole('menuitem', { name: '完全に削除…' }).click()
  const purge = page.getByRole('dialog', { name: '選んだ画像を完全に削除する' })
  await expect(purge).toContainText('元に戻せません')
  await purge.getByRole('button', { name: '削除する' }).click()
  await expect(status).toContainText('ゴミ箱 1枚')

  await thumbs(page).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '元に戻す' }).click()
  await expect(status).toContainText('ゴミ箱 0枚')

  await sidebar.getByRole('button', { name: /^見つからない/ }).click()
  await thumbs(page).first().click({ button: 'right' })
  await expect(menuItems(page)).toHaveText(['一覧から外す…'])
  await page.getByRole('menuitem', { name: '一覧から外す…' }).click()
  const forget = page.getByRole('dialog', { name: '選んだ画像を一覧から外す' })
  await expect(forget).toContainText('タグ、メモ、評価を削除します')
  await forget.getByRole('button', { name: 'キャンセル' }).click()
  await expect(forget).toHaveCount(0)
})

test('右クリックの「1つ上のカテゴリへ移す」で、それぞれの親へ移し、1つ上がない画像を含むと押せない（FR-416）', async ({
  page,
}) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const category = page.getByRole('complementary', { name: '詳細' }).getByRole('combobox', { name: 'カテゴリ' })
  const up = page.getByRole('menuitem', { name: '1つ上のカテゴリへ移す' })
  const status = page.getByRole('contentinfo')

  // ref_00002 は ポーズ / 座り、ref_00010 は 服飾 / 制服。揃っていなければ、それぞれの1つ上へ移す
  await thumb(page, 2).click()
  await thumb(page, 10).click({ modifiers: ['Meta'] })
  await thumb(page, 10).click({ button: 'right' })
  await expect(up).toBeEnabled()
  await up.click()
  await expect(status).toContainText('カテゴリを変更 2枚')
  await thumb(page, 2).click()
  await expect(category).toHaveValue('ポーズ')
  await thumb(page, 10).click()
  await expect(category).toHaveValue('服飾')

  // 一番上の階層（ref_00010 は服飾になった）と未分類（ref_00001）の画像では押せない
  await thumb(page, 10).click({ button: 'right' })
  await expect(up).toBeDisabled()
  await page.keyboard.press('Escape')
  await thumb(page, 3).click()
  await thumb(page, 1).click({ modifiers: ['Meta'] })
  await thumb(page, 1).click({ button: 'right' })
  await expect(up).toBeDisabled()
  await page.screenshot({ path: 'test-results/context-menu-category.png' })
})

test('右クリックの「カテゴリを変える…」で、既存のカテゴリか新しく作ったカテゴリへ移す。拡大表示でも同じ（FR-416）', async ({
  page,
}) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const category = page.getByRole('complementary', { name: '詳細' }).getByRole('combobox', { name: 'カテゴリ' })
  const status = page.getByRole('contentinfo')
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })

  // 既存のカテゴリ：詳細パネルと同じ欄で名前で絞り込み、Enter で移す
  await thumb(page, 3).click()
  await thumb(page, 4).click({ modifiers: ['Shift'] })
  await thumb(page, 4).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'カテゴリを変える…' }).click()
  const dialog = page.getByRole('dialog', { name: '2枚の画像のカテゴリを変える' })
  const target = dialog.getByRole('combobox', { name: '移す先' })
  // 開くと移す先の欄に入り、すべての候補を出す
  await expect(dialog.getByRole('listbox', { name: 'カテゴリ' }).getByRole('option')).toHaveCount(7)
  await page.screenshot({ path: 'test-results/category-dialog-list.png' })
  await target.fill('背景')
  await expect(dialog.getByRole('listbox', { name: 'カテゴリ' }).getByRole('option')).toHaveText(['背景'])
  await page.screenshot({ path: 'test-results/category-dialog.png' })
  await target.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(status).toContainText('カテゴリを変更 2枚')
  await thumb(page, 3).click()
  await expect(category).toHaveValue('背景')

  // 新しいカテゴリ：作れない名前は欄の下にエラーを出し、ダイアログを残す
  await thumb(page, 6).dblclick()
  await page
    .getByRole('region', { name: '拡大表示' })
    .getByRole('img', { name: 'ref_00006.jpg' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'カテゴリを変える…' }).click()
  const one = page.getByRole('dialog', { name: '1枚の画像のカテゴリを変える' })
  const name = one.getByRole('textbox', { name: '新しいカテゴリ' })
  await name.fill('座り')
  await one.getByRole('combobox', { name: '作る場所' }).selectOption({ label: 'ポーズ' })
  await one.getByRole('button', { name: '作って移す' }).click()
  await expect(one.getByRole('alert')).toContainText('同じ名前のファイルかフォルダがあります')
  await page.screenshot({ path: 'test-results/category-dialog-error.png' })
  await name.fill('立ち')
  await one.getByRole('button', { name: '作って移す' }).click()
  await expect(one).toHaveCount(0)
  await expect(status).toContainText('カテゴリを変更 1枚')
  await expect(category).toHaveValue('ポーズ / 立ち')
  await expect(sidebar.getByRole('button', { name: '立ち', exact: true })).toBeVisible()
})

test('絞り込んだカテゴリから「カテゴリを変える…」で移しても、一覧から外れた画像でダイアログが落ちない（FR-416）', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  await sidebar.getByRole('button', { name: '制服', exact: true }).click()
  await expect(page.getByRole('main', { name: '画像の一覧' })).toBeVisible()
  await thumbs(page).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'カテゴリを変える…' }).click()
  const dialog = page.getByRole('dialog', { name: '1枚の画像のカテゴリを変える' })
  await dialog.getByRole('combobox', { name: '移す先' }).fill('背景')
  await dialog.getByRole('combobox', { name: '移す先' }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).toContainText('カテゴリを変更 1枚')
  expect(errors).toEqual([])
})
