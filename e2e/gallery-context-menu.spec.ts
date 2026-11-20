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
  const expected = ['ボードに追加…', 'Finderで表示', 'ゴミ箱へ移す']
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
  await expect(menuItems(page)).toHaveText(['ボードに追加…', 'ゴミ箱へ移す'])
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
