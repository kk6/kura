import { expect, test } from './fixtures'
import { openGallery, switchLibrary, thumb, type TauriWindow } from './gallery-helpers'

test('起動時に前回のライブラリが見つからなければ、選択画面にその旨と最近使った一覧を出す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')

  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('alert')).toHaveText(
    'エラー：ライブラリが見つかりません（/Volumes/外付けSSD/参考資料）',
  )
  await expect(screen.getByRole('button', { name: /^参考資料 / })).toBeVisible()
  await expect(screen.getByRole('button', { name: /Kura ライブラリ/ })).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/library-select.png' })
})

test('見つからないライブラリを一覧から開いても、選択画面のまま見つからないと出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^参考資料 / }).click()
  await expect(page.getByRole('alert')).toContainText('見つかりません')
  await expect(page.getByRole('banner')).toHaveCount(0)
})

test('見つからないライブラリだけに「一覧から外す」を出し、押すと確認なしで一覧から消える', async ({ page }) => {
  await page.goto('/')
  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('button', { name: /^参考資料 .*見つかりません/ })).toBeVisible()
  await expect(screen.getByRole('button', { name: /一覧から外す/ })).toHaveCount(1)
  await page.screenshot({ path: 'test-results/library-forget.png' })

  await screen.getByRole('button', { name: '参考資料を一覧から外す' }).click()

  await expect(screen.getByRole('button', { name: /^参考資料 / })).toHaveCount(0)
  await expect(screen.getByRole('button', { name: /Kura ライブラリ/ })).toBeVisible()
  await expect(screen.getByRole('dialog')).toHaveCount(0)
})

test('ライブラリを新しく作るとギャラリー画面を出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいライブラリを作る' }).click()
  await expect(page.getByRole('banner')).toBeVisible()
})

test('一覧からライブラリを開くとギャラリー画面の枠が表示される', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()

  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'サイドバー' })).toBeVisible()
  await expect(page.getByRole('main', { name: '画像の一覧' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '詳細' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/gallery.png' })
})

test('Tauri のコマンドがモックに差し替わっている', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('main', { name: 'ライブラリ選択' })).toBeVisible()
  const message = await page.evaluate(() => {
    const tauri = (window as unknown as TauriWindow).__TAURI_INTERNALS__
    return tauri.invoke('no_such_command').catch((e: unknown) => String(e))
  })
  expect(message).toContain('モックが未定義のコマンド: no_such_command')
})

test('ライブラリを切り替えると選択画面に戻り、入力中のメモを保存し、最近使った一覧から開き直せる', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await thumb(page, 2).click()
  const memo = page.getByRole('complementary', { name: '詳細' }).getByRole('textbox', { name: 'メモ' })
  await memo.fill('切り替える前に書いたメモ')

  // ダイアログを開いている間は、ほかのショートカットと同じく効かない
  await page.getByRole('button', { name: '設定' }).click()
  await switchLibrary(page)
  await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible()
  await page.keyboard.press('Escape')
  await memo.click()

  // メモを保存できなければ切り替えず、入力欄の下とステータスバーにエラーを出す
  await memo.fill('失敗するメモ')
  await switchLibrary(page)
  await expect(page.getByRole('contentinfo')).toContainText('メモを保存できないため、ライブラリを切り替えられません')
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText('エラー：メモを保存できません')
  await memo.fill('切り替える前に書いたメモ')

  await switchLibrary(page)
  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('button', { name: '新しいライブラリを作る' })).toBeVisible()
  await expect(screen.getByRole('button', { name: /Kura ライブラリ/ })).toBeVisible()
  await expect(screen.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/library-switch.png' })

  await screen.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await thumb(page, 2).click()
  await expect(memo).toHaveValue('切り替える前に書いたメモ')
  expect(errors).toEqual([])
})

test('差分検出の途中ではライブラリを切り替えず、その理由をダイアログで出す', async ({ page }) => {
  const dialogs: string[] = []
  page.on('console', (m) => m.text().startsWith('dialog: ') && dialogs.push(m.text()))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('banner').getByRole('status')).toBeVisible()

  await switchLibrary(page)
  await expect.poll(() => dialogs).toEqual([expect.stringContaining('終わってから、もう一度選んでください')])
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await expect(page.getByRole('banner')).toBeVisible()
})
