import { expect, test } from '@playwright/test'

type TauriWindow = { __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> } }

test('起動時に前回のライブラリが見つからなければ、選択画面にその旨と最近使った一覧を出す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')

  const screen = page.getByRole('main', { name: 'ライブラリ選択' })
  await expect(screen.getByRole('alert')).toHaveText('エラー：ライブラリが見つかりません（/Volumes/外付けSSD/参考資料）')
  await expect(screen.getByRole('button', { name: /参考資料/ })).toBeVisible()
  await expect(screen.getByRole('button', { name: /Kura ライブラリ/ })).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/library-select.png' })
})

test('見つからないライブラリを一覧から開いても、選択画面のまま見つからないと出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /参考資料/ }).click()
  await expect(page.getByRole('alert')).toContainText('見つかりません')
  await expect(page.getByRole('banner')).toHaveCount(0)
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

async function openGallery(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('banner')).toBeVisible()
}

test('フォルダを取り込むと、ステータスバーに進み具合と結果を出し、スキップの一覧を開ける', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await page.getByRole('button', { name: 'フォルダを取り込む' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('取り込み中 240 / 481枚')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '240')
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/import-progress.png' })

  await expect(status).toContainText('完了：取り込み 477枚')
  await expect(status.getByRole('button', { name: '注意：スキップ 3枚' })).toBeVisible()
  await status.getByRole('button', { name: 'エラー：取り込めない 1件' }).click()

  const dialog = page.getByRole('dialog', { name: '取り込まなかったファイル（4件）' })
  await expect(dialog.getByRole('listitem')).toHaveCount(4)
  await expect(dialog).toContainText('注意：同じ画像がライブラリ（ゴミ箱を含む）にあります')
  await expect(dialog).toContainText('注意：対応していない形式です')
  await expect(dialog).toContainText('エラー：取り込めませんでした（画像を読めません')
  await page.screenshot({ path: 'test-results/import-skipped.png' })

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(errors).toEqual([])
})

test('ドロップしたファイルを取り込む', async ({ page }) => {
  await openGallery(page)

  await page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'tauri://drag-drop',
      payload: { paths: ['/Users/me/Downloads/a.jpg'], position: { x: 0, y: 0 } },
    }),
  )

  await expect(page.getByRole('contentinfo')).toContainText('完了：取り込み 477枚')
})

const thumbs = (page: import('@playwright/test').Page) => page.getByRole('main', { name: '画像の一覧' }).getByRole('img')

// 描いているサムネイルの列の数（transform の x の種類の数）
const columnCount = (page: import('@playwright/test').Page) =>
  thumbs(page).evaluateAll((imgs) => new Set(imgs.map((i) => (i as HTMLElement).style.transform.split(',')[0])).size)

test('一覧は2000枚のうち表示範囲の近くだけを描き、サムネイルは開いたライブラリの .kura/thumbs から読む', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await expect(page.getByRole('contentinfo')).toContainText('2000枚')
  const count = await thumbs(page).count()
  expect(count).toBeGreaterThan(20)
  expect(count).toBeLessThan(200)
  await expect(thumbs(page).first()).toHaveAttribute(
    'src',
    /#\/Users\/me\/Pictures\/Kura ライブラリ\/\.kura\/thumbs\/hash\d+\.jpg$/,
  )

  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  await expect(sidebar.getByRole('listitem').filter({ hasText: 'すべての画像' })).toContainText('2000')
  await expect(sidebar.getByRole('listitem').filter({ hasText: '未分類' })).toContainText('500')
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  await expect(categories.getByRole('listitem').filter({ hasText: 'ポーズ' })).toContainText('座り')
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('listitem')).toHaveText(['あおり', '座り', '振り返り'])
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/gallery-list.png' })
})

test('一番下までスクロールしても、表示範囲のサムネイルを描く', async ({ page }) => {
  await openGallery(page)
  const list = page.getByRole('main', { name: '画像の一覧' })

  await list.evaluate((el) => (el.scrollTop = el.scrollHeight))

  // 一覧の枠の中に見えているサムネイルの数
  const inView = () =>
    list.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return Array.from(el.querySelectorAll('img')).filter((i) => {
        const r = i.getBoundingClientRect()
        return r.bottom > box.top && r.top < box.bottom
      }).length
    })
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(10000)
  await expect.poll(inView).toBeGreaterThan(5)
  expect(await thumbs(page).count()).toBeLessThan(200)
  await page.screenshot({ path: 'test-results/gallery-bottom.png' })
})

test('スライダーでサムネイルを小さくすると列が増える', async ({ page }) => {
  await openGallery(page)
  const before = await columnCount(page)

  await page.getByRole('slider', { name: 'サムネイルの大きさ' }).fill('100')

  await expect.poll(() => columnCount(page)).toBeGreaterThan(before)
  await page.screenshot({ path: 'test-results/gallery-small.png' })
})

test('並べ替えを変えると並び順が変わる', async ({ page }) => {
  await openGallery(page)
  const sort = page.getByRole('combobox', { name: '並べ替え' })
  const first = () => thumbs(page).first().getAttribute('alt')

  await sort.selectOption({ label: 'ファイル名' })
  await expect.poll(first).toBe('ref_00001.jpg')

  await sort.selectOption({ label: '評価' })
  // 評価5（i % 6 === 5）の中で取り込み日が一番新しい画像
  await expect.poll(first).not.toBe('ref_00001.jpg')

  await sort.selectOption({ label: 'ランダム' })
  await expect(thumbs(page).first()).toBeVisible()
})

test('画像のないライブラリでは、一覧に取り込み方を出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいライブラリを作る' }).click()

  await expect(page.getByRole('main', { name: '画像の一覧' })).toContainText('画像がありません')
  await expect(page.getByRole('contentinfo')).toContainText('0枚')
})

const thumb = (page: import('@playwright/test').Page, n: number) =>
  thumbs(page).and(page.getByAltText(`ref_${String(n).padStart(5, '0')}.jpg`, { exact: true }))
const selectedNames = (page: import('@playwright/test').Page) =>
  page.locator('.list__thumb--selected').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('alt')).sort())

test('画像を選ぶと詳細パネルに詳細を出す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  await thumb(page, 1).click()

  await expect(detail.getByRole('heading')).toHaveText('ref_00001.jpg')
  await expect(detail.getByRole('img', { name: 'ref_00001.jpg のプレビュー' })).toBeVisible()
  const category = detail.getByRole('combobox', { name: 'カテゴリ' })
  await expect(category.locator('option:checked')).toHaveText('未分類')
  await expect(detail.getByRole('listitem')).toHaveText(['あおり', '座り'])
  await expect(detail).toContainText('元URLhttps://example.com/gallery/pose')
  await expect(detail).toContainText(/サイズ\d+ × \d+、177 KB/)
  await expect(detail).toContainText('腕の角度と')
  expect(await selectedNames(page)).toEqual(['ref_00001.jpg'])
  await page.screenshot({ path: 'test-results/detail.png' })

  // カテゴリは親からの道筋で出し、タグ・元URL・メモがなければ「なし」と出す
  await thumb(page, 2).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00002.jpg')
  await expect(category.locator('option:checked')).toHaveText('ポーズ / 座り')
  await expect(detail).toContainText('タグなし元URLなし')
  expect(errors).toEqual([])
})

test('Command で個別に、Shift で範囲で複数の画像を選べる', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  await thumb(page, 2).click()
  await thumb(page, 4).click({ modifiers: ['Meta'] })
  await expect(detail.getByRole('heading')).toHaveText('2枚を選んでいます')
  expect(await selectedNames(page)).toEqual(['ref_00002.jpg', 'ref_00004.jpg'])

  // 起点は最後に Command で選んだ ref_00004
  await thumb(page, 7).click({ modifiers: ['Shift'] })
  await expect(detail.getByRole('heading')).toHaveText('4枚を選んでいます')
  expect(await selectedNames(page)).toEqual(['ref_00004.jpg', 'ref_00005.jpg', 'ref_00006.jpg', 'ref_00007.jpg'])
  await page.screenshot({ path: 'test-results/multi-select.png' })

  await thumb(page, 5).click({ modifiers: ['Meta'] })
  expect(await selectedNames(page)).toEqual(['ref_00004.jpg', 'ref_00006.jpg', 'ref_00007.jpg'])
})

test('ダブルクリックで拡大し、左右キーで前後の画像に移り、Escape で閉じる', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const zoom = page.getByRole('region', { name: '拡大表示' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  await thumb(page, 2).dblclick()

  // サムネイルではなく元の画像を読む
  await expect(zoom.getByRole('img', { name: 'ref_00002.jpg' })).toHaveAttribute('src', /#\/Users\/me\/Pictures\/Kura ライブラリ\/_未分類\/ref_00002\.jpg$/)
  await page.screenshot({ path: 'test-results/zoom.png' })

  await page.keyboard.press('ArrowRight')
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00003.jpg')
  await expect(detail.getByRole('heading')).toHaveText('ref_00003.jpg')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00001.jpg')
  // 先頭より前には移らない
  await page.keyboard.press('ArrowLeft')
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00001.jpg')

  await page.keyboard.press('Escape')
  await expect(zoom).toHaveCount(0)
  expect(await selectedNames(page)).toEqual(['ref_00001.jpg'])

  await thumb(page, 1).dblclick()
  await zoom.getByRole('button', { name: '閉じる' }).click()
  await expect(zoom).toHaveCount(0)
  expect(errors).toEqual([])
})

test('詳細パネルで入力したメモと評価を保存する', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const pressed = () =>
    detail.getByRole('button', { name: /^評価/ }).evaluateAll((bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').length)
  const memo = detail.getByRole('textbox', { name: 'メモ' })

  // ref_00002 の評価は1
  await thumb(page, 2).click()
  await expect.poll(pressed).toBe(1)
  await detail.getByRole('button', { name: '評価 4' }).click()
  await expect.poll(pressed).toBe(4)
  await memo.fill('手の形を見る')
  await page.screenshot({ path: 'test-results/memo-rating.png' })

  // 別の画像を選ぶと入力欄から離れて保存され、選び直すと保存した値が出る
  await thumb(page, 3).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00003.jpg')
  await expect(memo).toHaveValue('')
  await thumb(page, 2).click()
  await expect(memo).toHaveValue('手の形を見る')
  await expect.poll(pressed).toBe(4)

  // 今の評価と同じ星を押すと評価なしに戻す
  await detail.getByRole('button', { name: '評価 4' }).click()
  await expect.poll(pressed).toBe(0)

  // 保存に失敗したら入力欄の下にエラーを出す
  await memo.fill('失敗するメモ')
  await memo.blur()
  await expect(detail).toContainText('エラー：メモを保存できません（disk I/O error）')
  await expect(memo).toHaveAttribute('aria-invalid', 'true')
  await page.screenshot({ path: 'test-results/memo-error.png' })
  expect(errors).toEqual([])
})

test('拡大表示の左右の端にマウスを乗せると < > を出し、押すと前後の画像に移る', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const zoom = page.getByRole('region', { name: '拡大表示' })

  // 先頭の画像では、前へ移るボタンを出さない
  await thumb(page, 1).dblclick()
  await expect(zoom.getByRole('button', { name: '前の画像' })).toHaveCount(0)

  const next = zoom.getByRole('button', { name: '次の画像' })
  const arrow = next.locator('.zoom__arrow')
  await expect(arrow).toBeHidden()
  await next.hover()
  await expect(arrow).toBeVisible()
  await page.screenshot({ path: 'test-results/zoom-nav.png' })
  await next.click()
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00002.jpg')

  await zoom.getByRole('button', { name: '前の画像' }).click()
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00001.jpg')
})

test('Escape で選択を外す。拡大表示中は先に拡大表示を閉じ、メモの入力中は外さない', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  await thumb(page, 2).click()
  await thumb(page, 3).click({ modifiers: ['Meta'] })
  await page.keyboard.press('Escape')
  expect(await selectedNames(page)).toEqual([])
  await expect(detail).toHaveText('画像を選ぶと、ここに詳細が出ます')

  await thumb(page, 2).dblclick()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  expect(await selectedNames(page)).toEqual(['ref_00002.jpg'])

  await detail.getByRole('textbox', { name: 'メモ' }).press('Escape')
  expect(await selectedNames(page)).toEqual(['ref_00002.jpg'])
})

test('選んだ画像のカテゴリとタグをまとめて変え、入力中は既存のタグを候補に出す', async ({ page }) => {
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
  await expect(category.locator('option:checked')).toHaveText('複数のカテゴリ')
  await expect(detail).toContainText('タグなし')

  // 大文字・小文字や正規化に関係なく、入力した文字を含む既存のタグを候補に出す
  await tagInput.fill('あお')
  const options = detail.getByRole('listbox', { name: '既存のタグ' }).getByRole('option')
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
  await expect(page.getByRole('list', { name: 'タグ' }).getByRole('listitem')).toHaveText(['あおり', '座り', '振り返り', '立ち'])

  // 一部の画像にだけ付いているタグは枚数を出す。外すと選んだ画像のすべてから外れる
  await thumb(page, 1).click({ modifiers: ['Meta'] })
  await expect(chips).toHaveText(['あおり', '座り1/4', '立ち3/4'])
  await detail.getByRole('button', { name: '立ち を外す' }).click()
  await expect(chips).toHaveText(['あおり', '座り1/4'])

  await category.selectOption({ label: '服飾 / 制服' })
  await expect(status).toContainText('完了：カテゴリを変更 4枚')
  await expect(category.locator('option:checked')).toHaveText('服飾 / 制服')
  await page.screenshot({ path: 'test-results/bulk-classify.png' })

  // 付けていない入力中のタグは、選び直すと消える
  await tagInput.fill('付けないタグ')
  await thumb(page, 3).click()
  await expect(category.locator('option:checked')).toHaveText('服飾 / 制服')
  await expect(chips).toHaveText(['あおり'])
  await expect(tagInput).toHaveValue('')

  // 移せなかった画像はステータスバーに件数を出し、押すと一覧を開く（モックでは ref_00007 を移せない）
  await thumb(page, 7).click({ modifiers: ['Meta'] })
  await category.selectOption({ label: '背景' })
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
    categories.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }).first()
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
  await expect(item('服飾')).toHaveClass(/sidebar__item--drop/)
  await page.screenshot({ path: 'test-results/category-drag.png' })
  await page.mouse.up()
  await expect(label).toHaveCount(0)

  // 離すと確認する。キャンセルすれば移さない
  await expect(dialog).toContainText('「振り返り」を「服飾」の下へ移します')
  await expect(dialog.getByRole('button', { name: '移す' })).toBeFocused()
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

  const saved = await page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('load_gallery'),
  )
  expect((saved as { categories: unknown[] }).categories).toEqual([
    { id: 1, name: 'ポーズ', parent_id: null },
    { id: 2, name: '制服', parent_id: null },
    { id: 3, name: '振り返り', parent_id: 4 },
    { id: 4, name: '服飾', parent_id: null },
    { id: 5, name: '制服', parent_id: 4 },
    { id: 6, name: '風景', parent_id: null },
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
    categories.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }).first()
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

  const saved = await page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('load_gallery'),
  )
  expect((saved as { categories: unknown[] }).categories.slice(6)).toEqual([
    { id: 7, name: '手', parent_id: null },
    { id: 8, name: '椅子', parent_id: 2 },
  ])
  expect(errors).toEqual([])
})
