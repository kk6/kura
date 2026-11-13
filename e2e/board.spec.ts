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

test('最後に使ったボードを開けなければ、選択画面にしてエラーを出す', async ({ page }) => {
  await page.addInitScript(() => {
    const board = (id: number, name: string) => ({ id, name, placement_count: 0, updated_at: id })
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({ boards: [board(1, '構図'), board(2, '開けない')], last: 2, next: 3 }),
    )
  })
  await page.goto('/?board')

  await expect(page.getByRole('alert')).toHaveText('エラー：database disk image is malformed')
  const choose = page.getByRole('main', { name: 'ボードを選ぶ' })
  await expect(choose.getByRole('button')).toHaveText(['開けない0枚', '構図0枚'])
  await choose.getByRole('button', { name: /構図/ }).click()
  await expect(page.getByRole('main', { name: 'キャンバス：構図' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

// メニューの「ボードに追加…」（⇧⌘B）。Rust はメニューを選ぶと add-to-board を送るだけなので、その送信を真似る
const menuAddToBoard = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'add-to-board',
      payload: null,
    }),
  )

type StoredBoards = {
  boards: {
    id: number
    name: string
    items?: {
      id: number
      source: { image_id: number }
      geometry: { x: number; y: number; width: number; height: number; scale: number }
    }[]
  }[]
  last: number | null
}
const storedBoards = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.boards') ?? '{"boards":[],"last":null}') as StoredBoards)

test('詳細パネルの「ボードに追加」で追加先を選び、キャンセルでは作らず、新しいボードに追加すると追加分を選んで全体を見せる', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const opened = boardWindowRequests(page)
  await openGallery(page)
  const thumbs = page.locator('.list__thumb')
  await thumbs.nth(0).click()
  await thumbs.nth(1).click({ modifiers: ['Meta'] })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const dialog = page.getByRole('dialog', { name: 'ボードに追加' })

  await detail.getByRole('button', { name: 'ボードに追加' }).click()
  await expect(dialog).toContainText('2枚の画像を追加します')
  await expect(dialog.getByRole('combobox', { name: '追加先' })).toHaveValue('new')
  await expect(dialog.getByRole('textbox', { name: '新しいボードの名前' })).toHaveValue('新しいボード')
  await page.screenshot({ path: 'test-results/board-add-dialog.png' })
  await dialog.getByRole('button', { name: 'キャンセル' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await storedBoards(page)).boards).toEqual([])
  expect(opened).toEqual([])

  await detail.getByRole('button', { name: 'ボードに追加' }).click()
  await dialog.getByRole('textbox', { name: '新しいボードの名前' }).fill('構図')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => opened.length).toBe(1)
  const stored = await storedBoards(page)
  expect(stored.boards.map((b) => [b.name, b.items?.length])).toEqual([['構図', 2]])

  await page.goto('/?board')
  await expect(page.getByRole('combobox', { name: 'ボード' })).toHaveValue(String(stored.boards[0].id))
  const canvas = page.getByRole('main', { name: 'キャンバス：構図' })
  const items = canvas.getByRole('img')
  await expect(items).toHaveCount(2)
  await expect(canvas.locator('.board__item--selected')).toHaveCount(2)
  // 追加分がすべてキャンバスの中に見える
  const area = (await canvas.boundingBox())!
  for (const box of await Promise.all([items.nth(0).boundingBox(), items.nth(1).boundingBox()])) {
    expect(box!.x).toBeGreaterThanOrEqual(area.x)
    expect(box!.y).toBeGreaterThanOrEqual(area.y)
    expect(box!.x + box!.width).toBeLessThanOrEqual(area.x + area.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(area.y + area.height)
  }
  await page.screenshot({ path: 'test-results/board-added.png' })
  expect(errors).toEqual([])
})

test('右クリックとメニューから開くダイアログは最後のボードを選び、同じ画像も別の配置として既存の配置の右に足す', async ({
  page,
}) => {
  const opened = boardWindowRequests(page)
  await openGallery(page)
  const thumbs = page.locator('.list__thumb')
  const dialog = page.getByRole('dialog', { name: 'ボードに追加' })
  await page.evaluate(() =>
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({
        boards: [
          { id: 1, name: '構図', placement_count: 0, updated_at: 2 },
          { id: 2, name: '服のしわ', placement_count: 0, updated_at: 1 },
        ],
        last: 2,
        next: 3,
      }),
    ),
  )

  // 選んでいない画像を右クリックすると、その画像だけを選ぶ
  await thumbs.nth(0).click()
  await thumbs.nth(3).click({ button: 'right' })
  await expect(page.locator('.list__thumb--selected')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/gallery-context-menu.png' })
  await page.getByRole('menuitem', { name: 'ボードに追加…' }).click()
  await expect(dialog.getByRole('combobox', { name: '追加先' })).toHaveValue('2')
  await expect(dialog).toContainText('1枚の画像を追加します')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog).toHaveCount(0)

  await menuAddToBoard(page)
  await expect(dialog.getByRole('combobox', { name: '追加先' })).toHaveValue('2')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => opened.length).toBe(2)

  const board = (await storedBoards(page)).boards.find((b) => b.id === 2)!
  const [first, second] = board.items!
  expect(first.id).not.toBe(second.id)
  expect(first.source.image_id).toBe(second.source.image_id)
  expect(second.geometry.x).toBeGreaterThan(first.geometry.x + first.geometry.width * first.geometry.scale)
})

test('選んでいない時、ゴミ箱、見つからない画像、OFF では追加できず、同じ名前のボードは入力欄の下にエラーを出す', async ({
  page,
}) => {
  await openGallery(page)
  const detail = page.getByRole('complementary', { name: '詳細' })
  const dialog = page.getByRole('dialog', { name: 'ボードに追加' })
  const add = detail.getByRole('button', { name: 'ボードに追加' })

  await menuAddToBoard(page)
  await expect(dialog).toHaveCount(0)
  await expect(add).toHaveCount(0)

  for (const aside of ['ゴミ箱', '見つからない']) {
    await page.getByRole('button', { name: new RegExp(`^${aside}`) }).click()
    await page.locator('.list__thumb').first().click()
    await page.locator('.list__thumb').first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'ボードに追加…' })).toBeHidden()
    await menuAddToBoard(page)
    await expect(dialog).toHaveCount(0)
  }

  await page.getByRole('button', { name: /^すべての画像/ }).click()
  await page.locator('.list__thumb').first().click()
  await page.evaluate(() =>
    sessionStorage.setItem(
      'mock.boards',
      JSON.stringify({ boards: [{ id: 1, name: '構図', placement_count: 0, updated_at: 1 }], last: 1, next: 2 }),
    ),
  )
  await add.click()
  await dialog.getByRole('combobox', { name: '追加先' }).selectOption('new')
  await dialog.getByRole('textbox', { name: '新しいボードの名前' }).fill(' 構図 ')
  await dialog.getByRole('button', { name: '追加' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('エラー：同じ名前のボードがあります')
  await page.screenshot({ path: 'test-results/board-add-name-error.png' })
  await dialog.getByRole('button', { name: 'キャンセル' }).click()
  expect((await storedBoards(page)).boards.map((b) => b.name)).toEqual(['構図'])

  await page.getByRole('button', { name: '設定' }).click()
  await page.getByRole('checkbox', { name: 'アイデアボードを使う' }).uncheck()
  await page.getByRole('dialog', { name: '設定' }).getByRole('button', { name: '閉じる' }).click()
  await expect(add).toHaveCount(0)
  await menuAddToBoard(page)
  await page.locator('.list__thumb').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'ボードに追加…' })).toBeHidden()
  await expect(dialog).toHaveCount(0)
})

test('ボードで1枚をドラッグすると、その配置だけが動いて保存される', async ({ page }) => {
  await openGallery(page)
  const thumbs = page.locator('.list__thumb')
  await thumbs.nth(0).click()
  await thumbs.nth(1).click({ modifiers: ['Meta'] })
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  const before = (await storedBoards(page)).boards[0].items!

  await page.goto('/?board')
  const items = page.getByRole('main', { name: /キャンバス/ }).getByRole('img')
  await expect(items).toHaveCount(2)
  // 追加した2枚が選ばれている。選択を外してから1枚だけを動かす
  const area = (await page.getByRole('main', { name: /キャンバス/ }).boundingBox())!
  await page.mouse.click(area.x + 10, area.y + 10)
  await expect(page.locator('.board__item--selected')).toHaveCount(0)
  const box = (await items.nth(0).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.board__item--selected')).toHaveCount(1)
  await expect
    .poll(async () => (await storedBoards(page)).boards[0].items![0].geometry.x)
    .toBeGreaterThan(before[0].geometry.x)
  const after = (await storedBoards(page)).boards[0].items!
  expect(after[0].geometry.y).toBeGreaterThan(before[0].geometry.y)
  expect(after[1].geometry).toEqual(before[1].geometry)
  await page.screenshot({ path: 'test-results/board-moved.png' })
})

test('保存の状態を示し、保存できなければ位置を残して再試行でき、それまで閉じる前の保存待ちに失敗を返す', async ({
  page,
}) => {
  await openGallery(page)
  await page.locator('.list__thumb').nth(0).click()
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  const before = (await storedBoards(page)).boards[0].items![0].geometry

  const flushed: string[] = []
  page.on('console', (m) => m.text().startsWith('flush_done') && flushed.push(m.text()))
  await page.goto('/?board')
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await page.evaluate(() => sessionStorage.setItem('mock.failBoardSave', '1'))
  const item = page.getByRole('main', { name: /キャンバス/ }).getByRole('img')
  const box = (await item.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('エラー：保存できませんでした（attempt to write a readonly database）')
  await expect.poll(async () => (await item.boundingBox())!.x).toBeGreaterThan(box.x + 30)
  expect((await storedBoards(page)).boards[0].items![0].geometry).toEqual(before)

  // Rust の保存待ち（閉じる・終了・切り替え）は、保存できないので失敗を受け取る
  const emitFlush = (id: number) =>
    page.evaluate(
      (id) =>
        (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
          event: 'flush',
          payload: id,
        }),
      id,
    )
  await emitFlush(1)
  await expect.poll(() => flushed).toEqual(['flush_done: attempt to write a readonly database'])

  await page.evaluate(() => sessionStorage.removeItem('mock.failBoardSave'))
  await alert.getByRole('button', { name: '再試行' }).click()
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await expect.poll(async () => (await storedBoards(page)).boards[0].items![0].geometry.x).toBeGreaterThan(before.x)
  await emitFlush(2)
  await expect.poll(() => flushed).toHaveLength(2)
  expect(flushed[1]).toBe('flush_done: ok')
})
