import { expect, test } from './fixtures'
import { columnCount, openGallery, selectedNames, thumb } from './gallery-helpers'

test('設定ダイアログでカテゴリの移動の確認を戻し、管理情報を書き出す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const item = (name: string) =>
    sidebar.getByRole('list', { name: 'カテゴリ' }).locator('.sidebar__item--category').getByText(name, { exact: true })
  const heading = sidebar.getByRole('heading', { name: 'カテゴリ' })
  const moveDialog = page.getByRole('dialog', { name: 'カテゴリを移す' })
  const settings = page.getByRole('dialog', { name: '設定' })
  const confirm = settings.getByRole('checkbox', { name: 'サイドバーでカテゴリを移すときに確認する' })

  await page.getByRole('button', { name: '設定' }).click()
  await expect(confirm).toBeChecked()
  await confirm.uncheck()
  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(settings).toHaveCount(0)

  // 確認しない設定は開き直しても残り、確認せずに移す
  await openGallery(page)
  await item('座り').dragTo(heading)
  await expect(moveDialog).toHaveCount(0)
  await expect(item('座り')).toBeVisible()

  await page.getByRole('button', { name: '設定' }).click()
  await expect(confirm).not.toBeChecked()
  await confirm.check()
  await settings.getByRole('button', { name: '管理情報を書き出す…' }).click()
  await expect(settings).toContainText('完了：/Users/me/Documents/Kura ライブラリ-')
  await page.screenshot({ path: 'test-results/settings.png' })
  await settings.getByRole('button', { name: '閉じる' }).click()

  await item('振り返り').dragTo(heading)
  await expect(moveDialog).toBeVisible()
  expect(errors).toEqual([])
})

test('検索・選択・拡大表示・タグ付け・ゴミ箱・設定をキーボードだけで行える（NFR-12）', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  const detail = page.getByRole('complementary', { name: '詳細' })
  const zoom = page.getByRole('region', { name: '拡大表示' })
  const search = page.getByRole('combobox', { name: '検索' })

  // ⌘F で検索欄へ移る。入力中の矢印キーや Space は一覧の操作にしない
  await page.keyboard.press('Meta+f')
  await expect(search).toBeFocused()
  await page.keyboard.type('ref_0000 ')
  await page.keyboard.press('ArrowRight')
  expect(await selectedNames(page)).toEqual([])
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())

  // 矢印キーで選ぶ。何も選んでいなければ先頭から
  await page.keyboard.press('ArrowRight')
  await expect(detail.getByRole('heading')).toHaveText('ref_00001.jpg')
  await page.keyboard.press('ArrowRight')
  await expect(detail.getByRole('heading')).toHaveText('ref_00002.jpg')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowDown')
  await expect(detail.getByRole('heading')).not.toHaveText('ref_00001.jpg')
  expect(await selectedNames(page)).toHaveLength(1)
  await page.keyboard.press('ArrowUp')
  await expect(detail.getByRole('heading')).toHaveText('ref_00001.jpg')

  // 下へ進み続けると、選んだ画像が見えるようにスクロールする
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown')
  await expect(page.locator('.list__thumb--selected')).toBeInViewport()

  // Space で拡大表示を開いて閉じる
  await page.keyboard.press('ArrowRight')
  const name = await detail.getByRole('heading').textContent()
  await page.keyboard.press(' ')
  await expect(zoom.getByRole('img')).toHaveAccessibleName(name!)
  await page.keyboard.press(' ')
  await expect(zoom).toHaveCount(0)

  // T でタグの入力欄へ移る。t は入力欄に入れない
  await page.keyboard.press('t')
  const tagInput = detail.getByRole('combobox', { name: 'タグ' })
  await expect(tagInput).toBeFocused()
  await expect(tagInput).toHaveValue('')
  await page.keyboard.type('手元')
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('listitem').filter({ hasText: '手元' })).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())

  // ⌘A ですべて選び、⌘Delete でゴミ箱へ移す
  await page.keyboard.press('Meta+a')
  await expect(detail.getByRole('heading')).toHaveText('2000枚を選んでいます')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(detail.getByRole('heading')).toHaveText('ref_00001.jpg')
  await page.keyboard.press('Meta+Backspace')
  await expect(page.getByRole('contentinfo')).toContainText('完了：ゴミ箱へ移した 1枚')
  await expect(thumb(page, 1)).toHaveCount(0)

  // ⌘, で設定を開く
  await page.keyboard.press('Meta+,')
  await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible()
  expect(errors).toEqual([])
})

test('UIのリニューアルで足した、ライブラリのメニュー、一覧の上の帯、詳細パネルの開閉、選択の印、Finder で開く操作', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const finder: string[] = []
  page.on('console', (m) => m.text().startsWith('finder: ') && finder.push(m.text()))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  // 帯の見出しはサイドバーで選んだもの。枚数は今の一覧の枚数
  const toolbar = page.locator('.gallery__toolbar')
  await expect(toolbar.getByRole('heading')).toHaveText('すべての画像')
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /未分類/ })
    .click()
  await expect(toolbar.getByRole('heading')).toHaveText('未分類')
  await expect(toolbar).toContainText('500枚')
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /すべての画像/ })
    .click()

  // 選んだ画像だけに印を出し、ステータスバーに選んでいる枚数を出す
  await thumb(page, 1).click()
  await thumb(page, 2).click({ modifiers: ['Meta'] })
  await expect(page.locator('.list__check')).toHaveCount(2)
  await expect(page.getByRole('contentinfo')).toContainText('2枚を選択')

  // Finder で開く。画像は1枚のときだけ、ライブラリの場所はサイドバーの下から
  await thumb(page, 1).click()
  await detail.getByRole('button', { name: 'Finderで表示' }).click()
  await page.getByRole('button', { name: /ライブラリの場所/ }).click()
  await expect.poll(() => finder).toEqual(['finder: 1', 'finder: root'])

  // × と ⌘I で閉じ、帯のボタンで開く。閉じている間に選び直しても開かない
  await detail.getByRole('button', { name: '詳細パネルを閉じる' }).click()
  await expect(detail).toHaveCount(0)
  await thumb(page, 2).click()
  await expect(detail).toHaveCount(0)
  await page.getByRole('button', { name: '詳細パネルを開く' }).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00002.jpg')
  await page.keyboard.press('Meta+i')
  await expect(detail).toHaveCount(0)
  await page.keyboard.press('Meta+i')
  await expect(detail).toBeVisible()
  // 開いた直後は、一覧が狭くなった幅に並べ直る前のことがある。並べ直しを待ってから撮る
  await expect.poll(() => columnCount(page)).toBe(4)
  // パネルが開くと帯のボタンが動く。マウスが乗った見た目が残るかはタイミングで変わるので、見出しの上へ動かして揃える
  await detail.getByRole('heading').hover()
  await page.screenshot({ path: 'test-results/renewal.png' })

  // ライブラリのメニューで別のライブラリを選ぶと、選択画面を通らずに開く。見つからなければ選択画面に出す
  const library = page.getByRole('combobox', { name: 'ライブラリ' })
  await expect(library.locator('option:checked')).toHaveText('Kura ライブラリ')
  await library.selectOption({ label: '参考資料' })
  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('alert')).toBeVisible()
  await screen.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await library.selectOption({ label: 'ほかのライブラリを開く…' })
  await expect(screen.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})
