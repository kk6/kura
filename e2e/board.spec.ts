import { expect, test, type Page } from '@playwright/test'

type TauriWindow = { __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> } }

// モックではボードの専用ウィンドウを開けない。ギャラリーは開く要求をコンソールに出し、ボードの画面は ?board で開く
const boardWindowRequests = (page: Page) => {
  const opened: string[] = []
  page.on('console', (m) => m.text() === 'board window' && opened.push(m.text()))
  return opened
}

async function openGallery(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

// メニューの「アイデアボードを開く」（⌘B）。Rust はメニューを選ぶと open-board を送るだけなので、その送信を真似る
const menuOpenBoard = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'open-board',
      payload: null,
    }),
  )

test('ヘッダーの「アイデアボード」とメニューで専用ウィンドウを開き、選んだ画像は追加しない。ボードの画面のコードは読まない', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const loaded: string[] = []
  page.on('request', (r) => r.url().includes('/src/board/') && loaded.push(r.url()))
  const opened = boardWindowRequests(page)
  await openGallery(page)

  await page.locator('.list__thumb').first().click()
  await page.getByRole('banner').getByRole('button', { name: 'アイデアボード' }).click()
  await expect.poll(() => opened.length).toBe(1)
  await menuOpenBoard(page)
  await expect.poll(() => opened.length).toBe(2)
  await expect(page.locator('.list__thumb--selected')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/gallery-board-button.png' })

  expect(loaded).toEqual([])
  expect(errors).toEqual([])
})

test('設定でアイデアボードを OFF にするとボタンとメニューの操作が消え、ON で戻る。保存できなければ ON のまま', async ({
  page,
}) => {
  const opened = boardWindowRequests(page)
  await openGallery(page)
  const button = page.getByRole('banner').getByRole('button', { name: 'アイデアボード' })
  const settings = page.getByRole('dialog', { name: '設定' })
  const toggle = settings.getByRole('checkbox', { name: 'アイデアボードを使う' })

  await page.getByRole('button', { name: '設定' }).click()
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect(button).toHaveCount(0)
  await page.screenshot({ path: 'test-results/settings-board-off.png' })
  await settings.getByRole('button', { name: '閉じる' }).click()
  await menuOpenBoard(page)

  // OFF は開き直しても残る
  await openGallery(page)
  await expect(button).toHaveCount(0)
  await page.getByRole('button', { name: '設定' }).click()
  await toggle.check()
  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(button).toBeVisible()
  expect(opened).toEqual([])

  await page.evaluate(() => sessionStorage.setItem('mock.failSettings', '1'))
  await page.getByRole('button', { name: '設定' }).click()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(button).toBeVisible()
  await expect(page.getByRole('contentinfo')).toContainText('エラー：設定を保存できません')
})

test('ボードがなければ「ボードを作成」を出し、キャンセルでは作らない。作ったボードを上部で切り替え・名前変更できる', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?board')
  const dialog = page.getByRole('dialog', { name: '新しいボード' })
  const name = dialog.getByRole('textbox', { name: 'ボード名' })
  const select = page.getByRole('combobox', { name: 'ボード' })

  await page.getByRole('button', { name: 'ボードを作成' }).click()
  await expect(name).toHaveValue('新しいボード')
  // 開くときの動きが終わってから撮る
  await expect(dialog).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/board-create.png' })
  await dialog.getByRole('button', { name: 'キャンセル' }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'ボードを作成' })).toBeVisible()

  await page.getByRole('button', { name: 'ボードを作成' }).click()
  await dialog.getByRole('button', { name: '作成' }).click()
  await expect(select).toHaveValue('1')
  await expect(page.getByRole('main', { name: 'キャンバス：新しいボード' })).toBeVisible()

  // 名前の検査：空白だけ、NFC と大文字小文字の違いだけの重複、101文字はエラー。100文字と / は使える
  await page.getByRole('button', { name: '新しいボード' }).click()
  await expect(name).toHaveValue('新しいボード 2')
  for (const [bad, message] of [
    ['  ', '1〜100文字'],
    [' 新しいボード ', '同じ名前のボードがあります'],
    ['あ'.repeat(101), '1〜100文字'],
  ]) {
    await name.fill(bad)
    await dialog.getByRole('button', { name: '作成' }).click()
    await expect(dialog.getByRole('alert')).toContainText(message)
    await expect(name).toHaveAttribute('aria-invalid', 'true')
  }
  await page.screenshot({ path: 'test-results/board-name-error.png' })
  await name.fill('あ'.repeat(100))
  await dialog.getByRole('button', { name: '作成' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(select).toHaveValue('2')

  await page.getByRole('button', { name: '新しいボード' }).click()
  await name.fill('ポーズ/座り')
  await dialog.getByRole('button', { name: '作成' }).click()
  await expect(select).toHaveValue('3')

  await select.selectOption({ label: '新しいボード' })
  await expect(page.getByRole('main', { name: 'キャンバス：新しいボード' })).toBeVisible()
  await page.getByRole('button', { name: 'ボードの操作' }).click()
  await page.getByRole('menuitem', { name: '名前を変更…' }).click()
  const rename = page.getByRole('dialog', { name: 'ボードの名前を変更' })
  await expect(rename.getByRole('textbox', { name: 'ボード名' })).toHaveValue('新しいボード')
  await rename.getByRole('textbox', { name: 'ボード名' }).fill('ポーズ/座り')
  await rename.getByRole('button', { name: '変更' }).click()
  await expect(rename.getByRole('alert')).toContainText('同じ名前のボードがあります')
  await rename.getByRole('textbox', { name: 'ボード名' }).fill('構図')
  await rename.getByRole('button', { name: '変更' }).click()
  await expect(select.getByRole('option', { name: '構図' })).toHaveCount(1)
  await expect(page.getByRole('main', { name: 'キャンバス：構図' })).toBeVisible()
  await page.screenshot({ path: 'test-results/board-toolbar.png' })

  // 閉じて開き直すと最後に使ったボードを出す
  await page.reload()
  await expect(page.getByRole('main', { name: 'キャンバス：構図' })).toBeVisible()
  expect(errors).toEqual([])
})

test('ボードの削除は名前と配置の件数を示し、キャンセルで残す。削除後は選択画面、最後の1つを消すと「ボードを作成」', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mock.boards')) return
    const board = (id: number, name: string, placement_count: number) => ({ id, name, placement_count, updated_at: id })
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({ boards: [board(1, '構図', 3), board(2, '削除できない', 1)], last: 1, next: 3 }),
    )
  })
  await page.goto('/?board')
  const confirm = page.getByRole('dialog', { name: 'ボードを削除' })
  const remove = async () => {
    await page.getByRole('button', { name: 'ボードの操作' }).click()
    await page.getByRole('menuitem', { name: '削除…' }).click()
  }

  await remove()
  await expect(confirm).toContainText('「構図」と、置いた画像 3枚の配置を削除します。元の画像はライブラリに残ります。')
  // 開くときの動きが終わってから撮る
  await expect(confirm).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/board-delete.png' })
  await confirm.getByRole('button', { name: 'キャンセル' }).click()
  await expect(page.getByRole('main', { name: 'キャンバス：構図' })).toBeVisible()

  await remove()
  await confirm.getByRole('button', { name: '削除する' }).click()
  const choose = page.getByRole('main', { name: 'ボードを選ぶ' })
  await expect(choose.getByRole('button')).toHaveText(['削除できない1枚'])
  await page.screenshot({ path: 'test-results/board-choose.png' })

  // 最後に使ったボードが削除済みなら、開き直しても選択画面を出す
  await page.reload()
  await expect(choose).toBeVisible()

  // 削除に失敗したらボードを開いたままエラーを出す
  await choose.getByRole('button', { name: /削除できない/ }).click()
  await remove()
  await confirm.getByRole('button', { name: '削除する' }).click()
  await expect(page.getByRole('alert')).toHaveText('エラー：database is locked')
  await expect(page.getByRole('main', { name: 'キャンバス：削除できない' })).toBeVisible()

  await page.evaluate(() => {
    const data = JSON.parse(sessionStorage.getItem('mock.boards')!)
    data.boards[0].name = '最後'
    sessionStorage.setItem('mock.boards', JSON.stringify(data))
  })
  await page.reload()
  await remove()
  await confirm.getByRole('button', { name: '削除する' }).click()
  await expect(page.getByRole('button', { name: 'ボードを作成' })).toBeVisible()
})
