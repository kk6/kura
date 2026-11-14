import { expect, test } from './fixtures'
import { openGallery, thumb, type TauriWindow } from './gallery-helpers'

test('選んだ画像のカテゴリとタグをまとめて変え、入力欄を押すと一覧を出し、入力中は名前で絞り込む', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const category = detail.getByRole('combobox', { name: 'カテゴリ' })
  const tagInput = detail.getByRole('combobox', { name: 'タグ' })
  const chips = detail.locator('.tag')
  const status = page.getByRole('contentinfo')

  // ref_00002〜4 のカテゴリは 座り・振り返り・服飾 で、タグはない
  await thumb(page, 2).click()
  await thumb(page, 4).click({ modifiers: ['Shift'] })
  await expect(detail.getByRole('heading')).toHaveText('3枚を選んでいます')
  await expect(category).toHaveValue('')
  await expect(category).toHaveAttribute('placeholder', '複数のカテゴリ')
  await expect(detail).toContainText('タグなし')

  // 何も入れずに入力欄を押すと、すべてのタグを名前の順に出す
  await tagInput.click()
  const options = detail.getByRole('listbox', { name: '既存のタグ' }).getByRole('option')
  await expect(options).toHaveText(['あおり', '座り', '振り返り'])

  // 大文字・小文字や正規化に関係なく、入力した文字を含む既存のタグを候補に出す
  await tagInput.fill('あお')
  await expect(options).toHaveText(['あおり'])
  await page.screenshot({ path: 'test-results/tag-candidates.png' })
  await tagInput.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await tagInput.press('Enter')
  await expect(chips).toHaveText(['あおり'])
  await expect(tagInput).toHaveValue('')

  // 新しい名前は新しいタグとして付け、サイドバーのタグ一覧にも出す
  await tagInput.fill('立ち')
  await tagInput.press('Enter')
  await expect(chips).toHaveText(['あおり', '立ち'])
  await expect(page.getByRole('list', { name: 'タグ' }).locator('.sidebar__name')).toHaveText([
    'あおり',
    '座り',
    '振り返り',
    '立ち',
  ])

  // 一部の画像にだけ付いているタグは枚数を出す。外すと選んだ画像のすべてから外れる
  await thumb(page, 1).click({ modifiers: ['Meta'] })
  await expect(chips).toHaveText(['あおり', '座り1/4', '立ち3/4'])
  await detail.getByRole('button', { name: '立ち を外す' }).click()
  await expect(chips).toHaveText(['あおり', '座り1/4'])

  // カテゴリは、押すと未分類とツリーの順のすべてを出し、文字を入れると道筋で絞り込む
  await category.click()
  const categoryOptions = detail.getByRole('listbox', { name: 'カテゴリ' }).getByRole('option')
  await expect(categoryOptions).toHaveText([
    '未分類',
    'ポーズ',
    'ポーズ / 座り',
    'ポーズ / 振り返り',
    '服飾',
    '服飾 / 制服',
    '背景',
  ])
  await page.screenshot({ path: 'test-results/category-candidates.png' })
  await category.fill('制服')
  await expect(categoryOptions).toHaveText(['服飾 / 制服'])
  await category.press('Enter')
  await expect(status).toContainText('完了：カテゴリを変更 4枚')
  await expect(category).toHaveValue('服飾 / 制服')
  await page.screenshot({ path: 'test-results/bulk-classify.png' })

  // 付けていない入力中のタグは、選び直すと消える
  await tagInput.fill('付けないタグ')
  await thumb(page, 3).click()
  await expect(category).toHaveValue('服飾 / 制服')
  await expect(chips).toHaveText(['あおり'])
  await expect(tagInput).toHaveValue('')

  // 移せなかった画像はステータスバーに件数を出し、押すと一覧を開く（モックでは ref_00007 を移せない）
  await thumb(page, 7).click({ modifiers: ['Meta'] })
  await category.click()
  await categoryOptions.filter({ hasText: /^背景$/ }).click()
  await expect(status).toContainText('完了：カテゴリを変更 1枚')
  await status.getByRole('button', { name: /移せない 1枚/ }).click()
  const dialog = page.getByRole('dialog', { name: '移せなかった画像（1枚）' })
  await expect(dialog).toContainText('ref_00007.jpg')
  await expect(dialog).toContainText('エラー：移動元が見つかりません')
  await page.screenshot({ path: 'test-results/move-failed.png' })
  expect(errors).toEqual([])
})

test('サイドバーでカテゴリ名を変え、ドラッグで別のカテゴリの下やルート直下へ移す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const item = (name: string) => categories.locator('.sidebar__item--category').getByText(name, { exact: true })
  const branch = (name: string) =>
    categories
      .getByRole('listitem')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
  const input = sidebar.getByRole('textbox', { name: 'カテゴリ名' })
  const status = page.getByRole('contentinfo')

  // 同名はエラーにして入力欄を残し、別の名前を入れ直してもらう
  await item('背景').dblclick()
  await input.fill('ポーズ')
  await input.press('Enter')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(sidebar).toContainText('エラー：同じ名前のファイルかフォルダがあります（ポーズ）')
  await page.screenshot({ path: 'test-results/category-rename-error.png' })
  await input.fill('風景')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(item('風景')).toBeVisible()

  // Escape では変えない
  await item('風景').dblclick()
  await input.fill('取り消す')
  await input.press('Escape')
  await expect(item('風景')).toBeVisible()

  // 掴んでいる間は、カーソルの横に何をどこへ移すかを出す
  const dialog = page.getByRole('dialog', { name: 'カテゴリを移す' })
  const label = sidebar.locator('.sidebar__drag')
  const box = async (name: string) => (await item(name).boundingBox())!
  const from = await box('振り返り')
  const to = await box('服飾')
  await page.mouse.move(from.x + 10, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(to.x + 10, to.y + 10, { steps: 5 })
  await expect(label).toHaveText('「振り返り」を「服飾」の下へ移す')
  await expect(categories.locator('.sidebar__item--drop .sidebar__name')).toHaveText('服飾')
  await page.screenshot({ path: 'test-results/category-drag.png' })
  await page.mouse.up()
  await expect(label).toHaveCount(0)

  // 離すと確認する。キャンセルすれば移さない
  await expect(dialog).toContainText('「振り返り」を「服飾」の下へ移します')
  await expect(dialog.getByRole('button', { name: '移す' })).toBeFocused()
  // 離した場所の行にマウスが乗った見た目が残るかは、ダイアログが開くタイミングで変わる。ダイアログの上へ動かして揃える
  await dialog.hover()
  await page.screenshot({ path: 'test-results/category-move-confirm.png' })
  await dialog.getByRole('button', { name: 'キャンセル' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(branch('ポーズ')).toContainText('振り返り')

  await item('振り返り').dragTo(item('服飾'))
  await dialog.getByRole('button', { name: '移す' }).click()
  await expect(branch('服飾')).toContainText('振り返り')
  await expect(branch('ポーズ')).not.toContainText('振り返り')

  // 自分の子孫の上では、移せないと出し、離しても何もしない
  const sit = await box('座り')
  await page.mouse.move((await box('ポーズ')).x + 10, (await box('ポーズ')).y + 10)
  await page.mouse.down()
  await page.mouse.move(sit.x + 10, sit.y + 10, { steps: 5 })
  await expect(label).toHaveText('「ポーズ」を自分の中へは移せません')
  await page.mouse.up()
  await expect(dialog).toHaveCount(0)
  await expect(branch('ポーズ')).toContainText('座り')

  // Escape でドラッグをやめる
  await page.mouse.move(sit.x + 10, sit.y + 10)
  await page.mouse.down()
  await page.mouse.move(to.x + 10, to.y + 10, { steps: 5 })
  await page.keyboard.press('Escape')
  await expect(label).toHaveCount(0)
  await page.mouse.up()
  await expect(dialog).toHaveCount(0)

  // 「今後は確認しない」を選ぶと、次からは確認せずに移す
  await item('座り').dragTo(sidebar.getByRole('heading', { name: 'カテゴリ' }))
  await expect(dialog).toContainText('「座り」を一番上の階層へ移します')
  await dialog.getByRole('checkbox', { name: '今後は確認しない' }).check()
  await dialog.getByRole('button', { name: '移す' }).click()
  await expect(branch('ポーズ')).not.toContainText('座り')

  // 移動先に同名があればエラーをステータスバーに出し、移さない
  await item('座り').dblclick()
  await input.fill('制服')
  await input.press('Enter')
  await item('制服').first().dragTo(item('服飾'))
  await expect(dialog).toHaveCount(0)
  await expect(status).toContainText('エラー：カテゴリを移せません（同じ名前のファイルかフォルダがあります（制服））')
  await page.screenshot({ path: 'test-results/category-move.png' })

  const saved = await page.evaluate(() => (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('load_gallery'))
  expect((saved as { categories: unknown[] }).categories).toEqual([
    { id: 1, name: 'ポーズ', parent_id: null, collapsed: false },
    { id: 2, name: '制服', parent_id: null, collapsed: false },
    { id: 3, name: '振り返り', parent_id: 4, collapsed: false },
    { id: 4, name: '服飾', parent_id: null, collapsed: false },
    { id: 5, name: '制服', parent_id: 4, collapsed: false },
    { id: 6, name: '風景', parent_id: null, collapsed: false },
  ])
  expect(errors).toEqual([])
})

test('サイドバーでルート直下とカテゴリの下に新しいカテゴリを作る', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const item = (name: string) => categories.locator('.sidebar__item--category').getByText(name, { exact: true })
  const branch = (name: string) =>
    categories
      .getByRole('listitem')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
  const input = sidebar.getByRole('textbox', { name: '新しいカテゴリ名' })

  // 同名はエラーにして入力欄を残す
  await sidebar.getByRole('button', { name: 'カテゴリを作る', exact: true }).click()
  await input.fill('服飾')
  await input.press('Enter')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(sidebar).toContainText('エラー：同じ名前のファイルかフォルダがあります（服飾）')
  await input.fill('手')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(item('手')).toBeVisible()

  // カテゴリの行のボタンはマウスを乗せると出る
  await item('座り').hover()
  await sidebar.getByRole('button', { name: '座り の下にカテゴリを作る' }).click()
  await input.fill('椅子')
  await page.screenshot({ path: 'test-results/category-create.png' })
  await input.press('Enter')
  await expect(branch('座り')).toContainText('椅子')

  // Escape では作らない
  await sidebar.getByRole('button', { name: 'カテゴリを作る', exact: true }).click()
  await input.fill('取り消す')
  await input.press('Escape')
  await expect(categories).not.toContainText('取り消す')

  const saved = await page.evaluate(() => (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('load_gallery'))
  expect((saved as { categories: unknown[] }).categories.slice(6)).toEqual([
    { id: 7, name: '手', parent_id: null, collapsed: false },
    { id: 8, name: '椅子', parent_id: 2, collapsed: false },
  ])
  expect(errors).toEqual([])
})

test('カテゴリを開閉でき、閉じた状態は開き直しても残る。階層には線を引く', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const item = (name: string) => categories.locator('.sidebar__item--category').getByText(name, { exact: true })
  const input = sidebar.getByRole('textbox', { name: '新しいカテゴリ名' })

  // 深い階層を作って線を見る
  for (const [parent, name] of [
    ['座り', '椅子'],
    ['椅子', '木の椅子'],
  ]) {
    await item(parent).hover()
    await sidebar.getByRole('button', { name: `${parent} の下にカテゴリを作る` }).click()
    await input.fill(name)
    await input.press('Enter')
  }
  await expect(item('木の椅子')).toBeVisible()
  await expect(categories.locator('.sidebar__list--nested')).toHaveCount(4)
  await page.screenshot({ path: 'test-results/category-tree.png' })

  await sidebar.getByRole('button', { name: 'ポーズ を閉じる' }).click()
  await expect(item('座り')).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: 'ポーズ を開く' })).toHaveAttribute('aria-expanded', 'false')
  await expect(item('制服')).toBeVisible()

  // 閉じたカテゴリの下に作るときは開く
  await item('ポーズ').hover()
  await sidebar.getByRole('button', { name: 'ポーズ の下にカテゴリを作る' }).click()
  await expect(item('座り')).toBeVisible()
  await input.press('Escape')

  await sidebar.getByRole('button', { name: 'すべて閉じる' }).click()
  await expect(item('座り')).toHaveCount(0)
  await expect(item('制服')).toHaveCount(0)
  await expect(item('背景')).toBeVisible()

  await openGallery(page)
  await expect(item('ポーズ')).toBeVisible()
  await expect(item('制服')).toHaveCount(0)
  await sidebar.getByRole('button', { name: '服飾 を開く' }).click()
  await expect(item('制服')).toBeVisible()
  expect(errors).toEqual([])
})

test('カテゴリを子カテゴリごと削除し、件数を確かめてから画像を未分類へ移す', async ({ page }) => {
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const item = (name: string) => categories.locator('.sidebar__item--category').getByText(name, { exact: true })
  const dialog = page.getByRole('dialog', { name: 'カテゴリを削除する' })
  const status = page.getByRole('contentinfo')
  const uncategorized = sidebar.getByRole('listitem').filter({ hasText: '未分類' })
  await expect(uncategorized).toContainText('500')

  // 消えるカテゴリの数と未分類へ移る枚数を出す。Enter だけで消さないようキャンセルを選んでおく
  await sidebar.getByRole('button', { name: '服飾 を削除する' }).click()
  await expect(dialog).toContainText('「服飾」と子カテゴリ 1個を削除します。中の画像 600枚は未分類へ移ります')
  await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeFocused()
  await page.screenshot({ path: 'test-results/category-delete-confirm.png' })
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(item('制服')).toBeVisible()

  await sidebar.getByRole('button', { name: '服飾 を削除する' }).click()
  await dialog.getByRole('button', { name: '削除する' }).click()
  await expect(item('服飾')).toHaveCount(0)
  await expect(item('制服')).toHaveCount(0)
  await expect(uncategorized).toContainText('1100')
  await expect(status).toContainText('完了：「服飾」を削除。未分類へ 600枚')

  // 移せない画像（モックの ref_00007 は「座り」にある）があれば、カテゴリを残して知らせる
  await sidebar.getByRole('button', { name: 'ポーズ を削除する' }).click()
  await expect(dialog).toContainText('「ポーズ」と子カテゴリ 2個を削除します')
  await dialog.getByRole('button', { name: '削除する' }).click()
  await expect(status).toContainText('「ポーズ」を削除できません（未分類へ移せない画像があるので')
  await expect(item('ポーズ')).toBeVisible()
  await expect(item('座り')).toBeVisible()
  await page.screenshot({ path: 'test-results/category-delete-failed.png' })
  await status.getByRole('button', { name: /移せない 1枚/ }).click()
  await expect(page.getByRole('dialog', { name: '移せなかった画像（1枚）' })).toContainText('ref_00007.jpg')
})

test('カテゴリ名の入力中に別のカテゴリを押すと、名前は変えずに入力をやめ、押したカテゴリで絞り込む', async ({
  page,
}) => {
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const input = sidebar.getByRole('textbox', { name: 'カテゴリ名' })

  await categories.getByRole('button', { name: '座り', exact: true }).dblclick()
  await input.fill('座る')
  await categories.getByRole('button', { name: '服飾', exact: true }).click()

  await expect(input).toHaveCount(0)
  await expect(categories.getByRole('button', { name: '座り', exact: true })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toContainText('600 / 2000枚')

  // 開閉ボタンを押したときも入力をやめる
  await categories.getByRole('button', { name: '振り返り', exact: true }).dblclick()
  await sidebar.getByRole('button', { name: '服飾 を閉じる' }).click()
  await expect(input).toHaveCount(0)
})
