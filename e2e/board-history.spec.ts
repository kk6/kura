import { expect, test, type Locator, type Page } from './fixtures'
import { boardWith, box, center, drag, emit, selectedIds, stored, type TauriWindow } from './board-helpers'

// ボードの重なり順と、取り消し・やり直し（FR-702、FR-704、NFR-12）

const items = async (page: Page) => (await stored(page)).items

// 奥から手前への配置 ID の並び
const stack = async (page: Page) =>
  [...(await items(page))]
    .sort((a, b) => a.geometry.stack_order - b.geometry.stack_order || a.id - b.id)
    .map((i) => i.id)

async function restack(page: Page, item: Locator, name: string) {
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test('移動・拡大縮小・配置を外す操作を、⌘Z で1つずつ取り消し、⇧⌘Z でやり直す。結果も保存する', async ({ page }) => {
  const { canvas, items: shown } = await boardWith(page, 3)
  const added = await items(page)

  // 途中で何度も動かしても、ドラッグ1回は1つの操作
  await shown.nth(0).click()
  const from = center(await box(shown.nth(0)))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let n = 1; n <= 8; n++) await page.mouse.move(from.x + n * 10, from.y + n * 5)
  await page.mouse.up()
  await expect.poll(async () => (await items(page))[0].geometry.x).toBeGreaterThan(added[0].geometry.x)
  const moved = await items(page)

  const frame = (await canvas.locator('.board__frame').boundingBox())!
  await drag(
    page,
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x + frame.width + 60, y: frame.y + frame.height + 60 },
  )
  await expect.poll(async () => (await items(page))[0].geometry.scale).toBeGreaterThan(moved[0].geometry.scale)
  const resized = await items(page)

  await shown.nth(1).click({ modifiers: ['Meta'] })
  await page.keyboard.press('Backspace')
  await expect(shown).toHaveCount(1)
  await expect.poll(() => items(page)).toEqual(resized.slice(2))

  // 外した配置は同じ配置 ID で戻り、外す前の選択も戻る
  await page.keyboard.press('Meta+z')
  await expect(shown).toHaveCount(3)
  await expect.poll(() => items(page)).toEqual(resized)
  expect(await selectedIds(canvas)).toEqual([added[0].id, added[1].id])
  await page.keyboard.press('Meta+z')
  await expect.poll(() => items(page)).toEqual(moved)
  await page.keyboard.press('Meta+z')
  await expect.poll(() => items(page)).toEqual(added)
  await expect(page.getByRole('status')).toHaveText('保存済み')

  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(() => items(page)).toEqual(moved)
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(() => items(page)).toEqual(resized)
  await page.keyboard.press('Shift+Meta+z')
  await expect(shown).toHaveCount(1)
  await expect.poll(() => items(page)).toEqual(resized.slice(2))
  // やり直す操作が残っていなければ何もしない
  await page.keyboard.press('Shift+Meta+z')
  await page.waitForTimeout(200)
  expect(await items(page)).toEqual(resized.slice(2))

  // 取り消した後に別の操作をすると、やり直せなくなる
  await page.keyboard.press('Meta+z')
  await expect(shown).toHaveCount(3)
  await page.mouse.click(10, 300)
  await shown.nth(2).click()
  await page.keyboard.press('Delete')
  await expect.poll(() => items(page)).toEqual(resized.slice(0, 2))
  await page.keyboard.press('Shift+Meta+z')
  await page.waitForTimeout(200)
  expect(await items(page)).toEqual(resized.slice(0, 2))

  // 開き直すと編集の結果は残り、履歴は残らない
  await page.reload()
  await expect(shown).toHaveCount(2)
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  expect(await items(page)).toEqual(resized.slice(0, 2))
})

test('ギャラリーからの追加を取り消すと追加分だけが外れ、やり直すと同じ配置 ID で戻る', async ({ page }) => {
  const { canvas, items: shown } = await boardWith(page, 2)
  const first = await items(page)

  // ボードを開いたまま、同じボードに1枚追加する。その前の移動も履歴に残す
  const from = center(await box(shown.nth(0)))
  await drag(page, from, { x: from.x + 40, y: from.y + 40 })
  await expect.poll(async () => (await items(page))[0].geometry.x).toBeGreaterThan(first[0].geometry.x)
  const moved = await items(page)
  await page.evaluate(async () => {
    const { invoke } = (window as unknown as TauriWindow).__TAURI_INTERNALS__
    const { session, boards } = (await invoke('list_boards')) as { session: number; boards: { id: number }[] }
    await invoke('add_to_board', { session, images: [3], target: { board: boards[0].id } })
  })
  await emit(page, 'board-reveal')
  await expect(shown).toHaveCount(3)
  await expect.poll(() => items(page)).toHaveLength(3)
  const added = await items(page)
  expect(await selectedIds(canvas)).toEqual([added[2].id])

  await page.keyboard.press('Meta+z')
  await expect(shown).toHaveCount(2)
  await expect.poll(() => items(page)).toEqual(moved)
  await page.keyboard.press('Meta+z')
  await expect.poll(() => items(page)).toEqual(first)
  await page.keyboard.press('Shift+Meta+z')
  await page.keyboard.press('Shift+Meta+z')
  await expect(shown).toHaveCount(3)
  await expect.poll(() => items(page)).toEqual(added)

  // 追加でボードを開いたときも、その追加を取り消せる。ボードは残る
  await page.reload()
  await expect(shown).toHaveCount(3)
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await page.locator('.list__thumb').nth(0).click()
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  await page.goto('/?board')
  await expect(shown).toHaveCount(4)
  await page.keyboard.press('Meta+z')
  await expect(shown).toHaveCount(3)
  await expect.poll(() => items(page)).toEqual(added)
  await expect(page.getByRole('combobox', { name: 'ボード' })).toBeVisible()
  // それより前の操作は、開く前のものなので取り消せない
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  expect(await items(page)).toEqual(added)
})

test('履歴はボードを切り替えると消える。入力欄・ダイアログ・保存待ちの間は ⌘Z が配置に効かない', async ({ page }) => {
  const { items: shown } = await boardWith(page, 2)
  const before = await items(page)
  await shown.nth(0).click()
  await page.keyboard.press('Backspace')
  await expect.poll(() => items(page)).toEqual(before.slice(1))

  // 名前の入力欄では、文字の取り消しだけに効く
  await page.getByRole('button', { name: 'ボードの操作' }).click()
  await page.getByRole('menuitem', { name: '名前を変更…' }).click()
  const name = page.getByRole('dialog').getByRole('textbox')
  await name.fill('')
  await name.pressSequentially('abc')
  await name.press('Meta+z')
  await name.press('Shift+Meta+z')
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).focus()
  await page.keyboard.press('Meta+z')
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
  await expect(shown).toHaveCount(1)

  // 閉じる前の保存待ちの間は受け付けない
  const flushed: string[] = []
  page.on('console', (m) => m.text().startsWith('flush_done') && flushed.push(m.text()))
  await emit(page, 'flush', 1)
  await expect.poll(() => flushed).toEqual(['flush_done: ok'])
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  await expect(shown).toHaveCount(1)
  expect(await items(page)).toEqual(before.slice(1))
  await emit(page, 'release')

  // 別のボードに切り替えて戻ると、外した配置は取り消しで戻らない
  await page.getByRole('button', { name: '新しいボード' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '作成' }).click()
  await expect(shown).toHaveCount(0)
  await page.keyboard.press('Meta+z')
  await page.getByRole('combobox', { name: 'ボード' }).selectOption({ index: 1 })
  await expect(shown).toHaveCount(1)
  await page.getByRole('main', { name: /キャンバス/ }).click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  await expect(shown).toHaveCount(1)
  expect(await items(page)).toEqual(before.slice(1))
})

test('右クリックのメニューで重なり順を変える。複数では選んだ配置同士の順序を保ち、取り消せる', async ({ page }) => {
  const { canvas, items: shown } = await boardWith(page, 4)
  const [a, b, c, d] = (await items(page)).map((i) => i.id)
  expect(await stack(page)).toEqual([a, b, c, d])

  // 選ぶ・動かすだけでは変わらない。右クリックは、選んでいない配置ならその1枚だけを選ぶ
  await shown.nth(0).click()
  const from = center(await box(shown.nth(0)))
  await drag(page, from, { x: from.x + 20, y: from.y + 20 })
  await expect.poll(async () => (await items(page))[0].geometry.x).not.toBe(0)
  expect(await stack(page)).toEqual([a, b, c, d])
  await shown.nth(1).click({ button: 'right' })
  expect(await selectedIds(canvas)).toEqual([b])
  const menu = page.getByRole('menu')
  // 重なり順の下に、1枚ずつの加工と「ギャラリーで表示」が続く。ON/OFF の項目（左右反転、グレースケール）は menuitemcheckbox
  await expect(menu.getByRole('menuitem')).toHaveText([
    '最前面へ',
    '1つ前へ',
    '1つ後ろへ',
    '最背面へ',
    '右へ90度回転',
    '回転をリセット',
    'トリミング',
    'トリミングを解除',
    'ギャラリーで表示',
  ])
  await page.screenshot({ path: 'test-results/board-restack-menu.png' })
  // Escape で閉じる。選択は残る
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await selectedIds(canvas)).toEqual([b])

  await restack(page, shown.nth(1), '1つ前へ')
  await expect.poll(() => stack(page)).toEqual([a, c, b, d])
  await restack(page, shown.nth(1), '最前面へ')
  await expect.poll(() => stack(page)).toEqual([a, c, d, b])
  await restack(page, shown.nth(1), '1つ後ろへ')
  await expect.poll(() => stack(page)).toEqual([a, c, b, d])
  await restack(page, shown.nth(1), '最背面へ')
  await expect.poll(() => stack(page)).toEqual([b, a, c, d])

  // 端にある配置は、それより先へ送れない
  await shown.nth(1).click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: '最背面へ' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '1つ後ろへ' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '最前面へ' })).toBeEnabled()
  await page.keyboard.press('Escape')

  // 複数を選んで右クリックすると、選択を保ったまま、相互の順序も保って動く
  await shown.nth(1).click()
  await shown.nth(2).click({ modifiers: ['Meta'] })
  await restack(page, shown.nth(2), '最前面へ')
  await expect.poll(() => stack(page)).toEqual([a, d, b, c])
  expect(await selectedIds(canvas)).toEqual([b, c])
  await restack(page, shown.nth(2), '1つ後ろへ')
  await expect.poll(() => stack(page)).toEqual([a, b, c, d])

  // 画面でも、手前の配置が上に描かれる
  await restack(page, shown.nth(0), '最前面へ')
  await expect.poll(() => stack(page)).toEqual([b, c, d, a])
  const order = () => shown.evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).zIndex)))
  expect(await order()).toEqual([3, 0, 1, 2])

  await page.keyboard.press('Meta+z')
  await expect.poll(() => stack(page)).toEqual([a, b, c, d])
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(() => stack(page)).toEqual([b, c, d, a])
  expect(await order()).toEqual([3, 0, 1, 2])

  // 開き直しても重なり順が残る
  await page.reload()
  await expect(shown).toHaveCount(4)
  expect(await order()).toEqual([3, 0, 1, 2])
})

test('外している間に削除された画像の配置は、取り消しで戻しても状態の枠のままにする', async ({ page }) => {
  const { canvas, items: shown } = await boardWith(page, 2)
  const before = await items(page)
  await shown.nth(0).click()
  await page.keyboard.press('Backspace')
  await expect.poll(() => items(page)).toEqual(before.slice(1))

  // 外した配置の画像が、ギャラリーで完全に削除された
  await page.evaluate(() => {
    const data = JSON.parse(sessionStorage.getItem('mock.boards')!)
    Object.assign(data.boards[0].removed[0].source, { status: 'deleted', image_id: null })
    sessionStorage.setItem('mock.boards', JSON.stringify(data))
  })
  await page.keyboard.press('Meta+z')
  await expect(shown).toHaveCount(2)
  await expect(canvas.getByRole('img', { name: /（削除された画像）/ })).toHaveCount(1)
  await expect(canvas.locator(`[data-id="${before[0].id}"] img`)).toHaveCount(0)
  expect((await items(page)).map((i) => i.id)).toEqual(before.map((i) => i.id))
  await page.screenshot({ path: 'test-results/board-undo-deleted.png' })
})
