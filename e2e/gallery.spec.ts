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
  // 開いた後の差分検出（FR-104）が終わるまで待つ。その間は取り込みを受け付けず、結果がステータスバーを上書きするため
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

test('フォルダを取り込むと、ステータスバーに進み具合と結果を出し、スキップの一覧を開ける', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)

  await page.getByRole('button', { name: 'フォルダを取り込む' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('取り込み中 240 / 481枚')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '240')
  // 取り込み中はボタンの代わりに処理中であることを出し、終わるとボタンに戻す
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('取り込み中…')
  await page.screenshot({ path: 'test-results/import-progress.png' })

  await expect(status).toContainText('完了：取り込み 477枚')
  await expect(page.getByRole('button', { name: '画像を取り込む' })).toBeEnabled()
  await expect(status).toContainText('完了：未分類から移した 3枚')
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
  await expect(sidebar.getByRole('list', { name: 'タグ' }).locator('.sidebar__name')).toHaveText(['あおり', '座り', '振り返り'])
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

test('スライダーでサムネイルを小さくすると列が増え、大きさは開き直しても残る', async ({ page }) => {
  await openGallery(page)
  const before = await columnCount(page)

  await page.getByRole('slider', { name: 'サムネイルの大きさ' }).fill('100')

  await expect.poll(() => columnCount(page)).toBeGreaterThan(before)
  await page.screenshot({ path: 'test-results/gallery-small.png' })
  const small = await columnCount(page)

  await openGallery(page)
  await expect(page.getByRole('slider', { name: 'サムネイルの大きさ' })).toHaveValue('100')
  await expect.poll(() => columnCount(page)).toBe(small)
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

test('詳細パネルで画像のファイル名を変える。拡張子は変えず、同名はエラーにする', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const input = detail.getByRole('textbox', { name: 'ファイル名（拡張子を除く）' })

  await thumb(page, 1).click()
  await detail.getByRole('heading').dblclick()
  await expect(input).toHaveValue('ref_00001')
  await expect(detail.getByRole('heading')).toHaveText('.jpg')

  // 同じフォルダ（未分類）の ref_00005.jpg と同名なので、入力欄を残して入れ直してもらう
  await input.fill('REF_00005')
  await input.press('Enter')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(detail).toContainText('エラー：同じ名前のファイルかフォルダがあります（REF_00005.jpg）')
  await page.screenshot({ path: 'test-results/image-rename-error.png' })

  await input.fill('ref_00001_立ち')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(detail.getByRole('heading')).toHaveText('ref_00001_立ち.jpg')
  await expect(page.locator('.list__thumb[alt="ref_00001_立ち.jpg"]')).toHaveCount(1)

  // Escape では変えない
  await detail.getByRole('heading').dblclick()
  await input.fill('取り消す')
  await input.press('Escape')
  await expect(detail.getByRole('heading')).toHaveText('ref_00001_立ち.jpg')
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
  await expect(page.getByRole('list', { name: 'タグ' }).locator('.sidebar__name')).toHaveText(['あおり', '座り', '振り返り', '立ち'])

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
  await expect(categories.locator('.sidebar__item--drop .sidebar__name')).toHaveText('服飾')
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

test('サイドバーのカテゴリとタグを押し、検索バーに入れると絞り込み、件数は子カテゴリを含めて数える', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const row = (name: string) => categories.locator('.sidebar__item').filter({ has: page.getByRole('button', { name, exact: true }) })

  // ポーズ（id 1）は 300枚、子の座り・振り返りは 300枚ずつ。ポーズの件数は子を含めて 900枚
  await expect(row('ポーズ').locator('.sidebar__count')).toHaveText('900')
  await expect(row('座り').locator('.sidebar__count')).toHaveText('300')

  await categories.getByRole('button', { name: 'ポーズ', exact: true }).click()
  await expect(status).toContainText('900 / 2000枚')
  await expect(row('ポーズ')).toHaveClass(/sidebar__item--selected/)

  await sidebar.getByRole('button', { name: /^未分類/ }).click()
  await expect(status).toContainText('500 / 2000枚')

  await sidebar.getByRole('button', { name: /^すべての画像/ }).click()
  await expect(status).toContainText('2000枚')
  await expect(status).not.toContainText('/ 2000枚')

  // 2〜10枚目以外は、id が3の倍数に「あおり」、5の倍数に「座り」が付く
  const tags = sidebar.getByRole('list', { name: 'タグ' })
  await tags.getByRole('button', { name: /^あおり/ }).click()
  await tags.getByRole('button', { name: /^座り/ }).click()
  await expect(tags.getByRole('button', { name: /^あおり/ })).toHaveAttribute('aria-pressed', 'true')
  // AND は 15 の倍数と1枚目、OR は 3 か 5 の倍数と1枚目
  await expect(status).toContainText('134 / 2000枚')
  await sidebar.getByRole('button', { name: 'OR' }).click()
  await expect(status).toContainText('929 / 2000枚')
  await page.screenshot({ path: 'test-results/filter-tags.png' })

  await sidebar.getByRole('button', { name: 'AND' }).click()
  await tags.getByRole('button', { name: /^座り/ }).click()
  await tags.getByRole('button', { name: /^あおり/ }).click()

  // 検索はファイル名かメモに含む画像。大文字・小文字は区別しない
  const search = page.getByRole('combobox', { name: '検索' })
  await search.fill('REF_0001')
  await expect(status).toContainText('10 / 2000枚')
  await search.fill('肩の線')
  await expect(status).toContainText('1 / 2000枚')
  await search.fill('')
  expect(errors).toEqual([])
})

test('見えなくなった画像の選択は絞り込みで外し、タグを外すと件数と絞り込みに反映する', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const detail = page.getByRole('complementary', { name: '詳細' })
  const aori = sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^あおり/ })

  await expect(aori.locator('.sidebar__count')).toHaveText('664')
  await aori.click()
  await expect(status).toContainText('664 / 2000枚')
  await thumb(page, 1).click()
  await detail.getByRole('button', { name: 'あおり を外す' }).click()
  await expect(aori.locator('.sidebar__count')).toHaveText('663')
  await expect(status).toContainText('663 / 2000枚')

  // 15枚目は制服にあるので、ポーズで絞ると見えなくなり、選択も外れる
  await thumb(page, 15).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00015.jpg')
  await sidebar.getByRole('list', { name: 'カテゴリ' }).getByRole('button', { name: 'ポーズ', exact: true }).click()
  await expect(detail).toContainText('画像を選ぶと、ここに詳細が出ます')
})

test('2万枚でも、タグ・カテゴリ・文字の絞り込みの結果が0.5秒以内に出る（NFR-02）', async ({ page }) => {
  await page.goto('/?images=20000')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('20000枚')

  // 押してから、ステータスバーの枚数が変わった後の最初の描画までの時間を測る
  const measure = (act: string) =>
    page.evaluate(async (act) => {
      const bar = document.querySelector('footer')!
      const before = bar.textContent
      const start = performance.now()
      if (act.startsWith('search:')) {
        const input = document.querySelector<HTMLInputElement>('input[type=search]')!
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(input, act.slice(7))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find((b) => b.textContent!.startsWith(act))!.click()
      }
      while (bar.textContent === before) await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => requestAnimationFrame(r))
      return performance.now() - start
    }, act)

  const times = {
    tag: await measure('あおり'),
    category: await measure('ポーズ'),
    text: await measure('search:ref_1'),
    clear: await measure('すべての画像'),
  }
  console.log('NFR-02 絞り込みの時間（ms）', times)
  for (const [name, ms] of Object.entries(times)) expect(ms, name).toBeLessThan(500)
})

test('タグ管理ダイアログで名前を変え、統合すると両方が付いていた画像も1つのタグになり、削除すると全部から外れる', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const sideTags = sidebar.getByRole('list', { name: 'タグ' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const status = page.getByRole('contentinfo')

  // 1枚目には「あおり」と「座り」が付いている。「座り」で絞っておく
  await thumb(page, 1).click()
  await expect(detail.locator('.tag')).toHaveText(['あおり', '座り'])
  await sideTags.getByRole('button', { name: /^座り/ }).click()
  await expect(status).toContainText('399 / 2000枚')

  await sidebar.getByRole('button', { name: 'タグを管理する' }).click()
  const dialog = page.getByRole('dialog', { name: 'タグを管理する' })
  const rows = dialog.getByRole('list', { name: 'タグ' }).locator('.tags__name')
  await expect(rows).toHaveText(['あおり', '座り', '振り返り'])
  await expect(dialog.getByRole('listitem').filter({ hasText: 'あおり' })).toContainText('664枚')

  // 名前の変更。ほかのタグと同じ名前はエラーにし、入力欄を残す
  await dialog.getByRole('button', { name: '「振り返り」の名前を変える' }).click()
  const input = dialog.getByRole('textbox', { name: '「振り返り」の新しい名前' })
  await input.fill('あおり')
  await input.press('Enter')
  await expect(dialog).toContainText('エラー：同じ名前のタグがあります（あおり）')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await page.screenshot({ path: 'test-results/tag-dialog-rename-error.png' })
  await input.fill('振り向き')
  await input.press('Enter')
  await expect(rows).toHaveText(['あおり', '座り', '振り向き'])
  await expect(sideTags.locator('.sidebar__name')).toHaveText(['あおり', '座り', '振り向き'])

  // 統合。「あおり」を「座り」にまとめる。1枚目は両方が付いているが「座り」1つになる
  await dialog.getByRole('button', { name: '「あおり」を統合する' }).click()
  await dialog.getByRole('combobox').selectOption({ label: '座り' })
  await expect(dialog).toContainText('「あおり」の 664枚に「座り」を付け、「あおり」を削除します')
  await page.screenshot({ path: 'test-results/tag-dialog-merge.png' })
  await dialog.getByRole('button', { name: '統合する', exact: true }).click()
  await expect(rows).toHaveText(['座り', '振り向き'])
  // 3 か 5 の倍数と1枚目
  await expect(dialog.getByRole('listitem').filter({ hasText: '座り' })).toContainText('929枚')

  // 削除。確かめてから全部の画像から外す
  await dialog.getByRole('button', { name: '「振り向き」を削除する' }).click()
  await expect(dialog).toContainText('「振り向き」を 284枚から外して削除します')
  await dialog.getByRole('button', { name: '削除する', exact: true }).click()
  await expect(rows).toHaveText(['座り'])

  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(dialog).toHaveCount(0)
  // 絞り込みの「座り」は残り、統合した分が増える。詳細パネルの1枚目のタグも読み直す
  await expect(sideTags.locator('.sidebar__name')).toHaveText(['座り'])
  await expect(status).toContainText('929 / 2000枚')
  await expect(detail.locator('.tag')).toHaveText(['座り'])
  expect(errors).toEqual([])
})

test('カテゴリ名の入力中に別のカテゴリを押すと、名前は変えずに入力をやめ、押したカテゴリで絞り込む', async ({ page }) => {
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

test('検索バーに入れると名前の合うカテゴリとタグを候補に出し、選ぶとそれで絞り込む', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const search = page.getByRole('combobox', { name: '検索' })
  const options = page.getByRole('listbox', { name: '絞り込みの候補' }).getByRole('option')
  const status = page.getByRole('contentinfo')
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })

  // 「座り」はカテゴリ（ポーズの下）とタグの両方にある
  await search.fill('座り')
  await expect(options).toHaveText(['カテゴリポーズ / 座り', 'タグ座り'])
  // 選ぶ前から、文字はタグ名とカテゴリ名にも探す。座りのカテゴリ 300枚と、座りのタグ 399枚（重ならない）
  await expect(status).toContainText('699 / 2000枚')
  await page.screenshot({ path: 'test-results/search-candidates.png' })

  // キーボードで選ぶ。入力した文字は消え、文字での絞り込みはやめる
  await search.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(search).toHaveValue('')
  await expect(status).toContainText('300 / 2000枚')
  await expect(
    sidebar.getByRole('list', { name: 'カテゴリ' }).getByRole('button', { name: '座り', exact: true }),
  ).toHaveAttribute('aria-current', 'true')

  // 押して選ぶ。いま使っているカテゴリは候補に出さない
  await search.fill('座り')
  await expect(options).toHaveText(['タグ座り'])
  await options.first().click()
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^座り/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 座りのカテゴリの画像（id を 5 で割って 2 余る）のうち、座りのタグ（5 の倍数）は付いていない
  await expect(status).toContainText('0 / 2000枚')

  // Tab と Shift+Tab で候補を移り、最後の候補で Tab を押すと次の部品（並べ替え）へ移る
  // 座りのカテゴリとタグは絞り込みに使っているので出さない
  await search.fill('り')
  await expect(options).toHaveText(['カテゴリポーズ / 振り返り', 'タグあおり', 'タグ振り返り'])
  await search.press('Tab')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await search.press('Tab')
  await search.press('Shift+Tab')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(search).toBeFocused()
  for (let i = 0; i < 2; i++) await search.press('Tab')
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true')
  await search.press('Tab')
  await expect(page.getByRole('combobox', { name: '並べ替え' })).toBeFocused()

  // 自動修正（cat を Cat にする提案）を出さない
  await expect(search).toHaveAttribute('autocorrect', 'off')
  await expect(search).toHaveAttribute('autocapitalize', 'off')

  // 合う候補がなければ出さず、Escape で文字を消す
  await search.fill('ref_0001')
  await expect(options).toHaveCount(0)
  await search.press('Escape')
  await expect(search).toHaveValue('')
  expect(errors).toEqual([])
})

test('選んだ画像をゴミ箱へ移し、ゴミ箱で元に戻し、確かめてから空にする', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const trashItem = sidebar.getByRole('button', { name: /^ゴミ箱/ })
  const status = page.getByRole('contentinfo')
  const all = sidebar.getByRole('button', { name: /^すべての画像/ })
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await expect(trashItem).toContainText('2')

  // 確認は出さずに移す。移せない画像（モックの ref_00007）は件数を出し、押すと一覧を開く
  await thumb(page, 1).click()
  await thumb(page, 2).click({ modifiers: ['Meta'] })
  await thumb(page, 7).click({ modifiers: ['Meta'] })
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ゴミ箱へ移す' }).click()
  await expect(status).toContainText('完了：ゴミ箱へ移した 2枚')
  await expect(status).toContainText('1998枚')
  await expect(thumb(page, 1)).toHaveCount(0)
  await expect(trashItem).toContainText('4')
  await expect(all).toContainText('1998')
  await status.getByRole('button', { name: /移せない 1枚/ }).click()
  await expect(page.getByRole('dialog', { name: '移せなかった画像（1枚）' })).toContainText('ref_00007.jpg')
  await page.keyboard.press('Escape')

  // ゴミ箱を開くと一覧がゴミ箱の画像になり、拡大表示はしない
  await trashItem.click()
  await expect(trashItem).toHaveAttribute('aria-current', 'true')
  await expect(all).toHaveAttribute('aria-current', 'false')
  await expect(thumbs(page)).toHaveCount(4)
  await expect(status).toContainText('ゴミ箱 4枚')
  const panel = page.getByRole('complementary', { name: 'ゴミ箱' })
  await expect(panel.getByRole('button', { name: '元に戻す' })).toBeDisabled()
  await thumb(page, 1).dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/trash.png' })

  // 元のカテゴリが消えた画像は未分類に戻して知らせる
  await page.getByRole('main', { name: '画像の一覧' }).getByAltText('deleted_1.jpg').click({ modifiers: ['Meta'] })
  await expect(panel).toContainText('2枚を選んでいます')
  await panel.getByRole('button', { name: '元に戻す' }).click()
  await expect(status).toContainText('完了：元に戻した 2枚')
  await expect(status).toContainText('お知らせ：元のカテゴリがないため未分類に戻した 1枚')
  await expect(thumbs(page)).toHaveCount(2)
  await expect(trashItem).toContainText('2')
  await expect(all).toContainText('2000')
  await page.screenshot({ path: 'test-results/trash-restored.png' })

  // 選んだ画像だけを完全に削除する。取り消せないので枚数を見せて確かめる
  await trashItem.click()
  await page.getByRole('main', { name: '画像の一覧' }).getByRole('img').first().click()
  await panel.getByRole('button', { name: '完全に削除' }).click()
  const purgeDialog = page.getByRole('dialog', { name: '選んだ画像を完全に削除する' })
  await expect(purgeDialog).toContainText('選んだ画像 1枚を完全に削除します。元に戻せません。')
  await page.screenshot({ path: 'test-results/trash-purge-confirm.png' })
  await purgeDialog.getByRole('button', { name: '削除する' }).click()
  await expect(status).toContainText('完了：ゴミ箱から削除した 1枚')
  await expect(thumbs(page)).toHaveCount(1)
  await expect(trashItem).toContainText('1')

  // 空にするのは取り消せないので、枚数を見せて確かめる。Enter だけでは空にしない
  await panel.getByRole('button', { name: 'ゴミ箱を空にする' }).click()
  const dialog = page.getByRole('dialog', { name: 'ゴミ箱を空にする' })
  await expect(dialog).toContainText('ゴミ箱の画像 1枚を完全に削除します。元に戻せません。')
  await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeFocused()
  await page.screenshot({ path: 'test-results/trash-empty-confirm.png' })
  await page.keyboard.press('Enter')
  await expect(thumbs(page)).toHaveCount(1)
  await panel.getByRole('button', { name: 'ゴミ箱を空にする' }).click()
  await dialog.getByRole('button', { name: '空にする' }).click()
  await expect(status).toContainText('完了：ゴミ箱から削除した 1枚')
  await expect(thumbs(page)).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'ゴミ箱を空にする' })).toBeDisabled()

  // ほかの場所を押すとゴミ箱を閉じる
  await all.click()
  await expect(page.getByRole('complementary', { name: '詳細' })).toBeVisible()
  await expect(thumb(page, 1)).toBeVisible()
  expect(errors).toEqual([])
})

test('開いた後に差分を確認して結果を出し、見つからない画像を開いて確かめてからDBから外す', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const missingItem = sidebar.getByRole('button', { name: /^見つからない/ })

  // 一覧を先に出してから差分を検出し、その間は進み具合を出して取り込みのボタンを止める
  await expect(status).toContainText('Finder での変更を反映中 2 / 4枚')
  await expect(status.getByRole('progressbar', { name: 'Finder での変更を反映する進み具合' })).toBeVisible()
  await expect(thumbs(page).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'フォルダを取り込む' })).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Finder での変更を反映中…')
  await page.screenshot({ path: 'test-results/scan-progress.png' })

  // 開いた後の差分検出の結果は、変わったものだけをステータスバーに出す
  await expect(status).toContainText('完了：差分を反映（登録 3枚、移動 1枚、カテゴリ追加 1件）')
  await expect(status).toContainText('注意：見つからない画像 2枚')
  await expect(missingItem).toContainText('2')
  await status.getByRole('button', { name: /スキップ 1枚/ }).click()
  await expect(page.getByRole('dialog', { name: '登録しなかったファイル（1件）' })).toContainText('メモ.txt')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'test-results/scan.png' })

  // 見つからない画像は一覧が変わり、拡大表示はしない
  await missingItem.click()
  await expect(missingItem).toHaveAttribute('aria-current', 'true')
  await expect(thumbs(page)).toHaveCount(2)
  await expect(status).toContainText('見つからない 2枚')
  const panel = page.getByRole('complementary', { name: '見つからない画像' })
  await expect(panel.getByRole('button', { name: 'DBから外す' })).toBeDisabled()
  await page.getByRole('main', { name: '画像の一覧' }).getByAltText('missing_1.jpg').dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/missing.png' })

  // 外すのは取り消せないので、枚数を見せて確かめる
  await panel.getByRole('button', { name: 'DBから外す' }).click()
  const dialog = page.getByRole('dialog', { name: '選んだ画像をDBから外す' })
  await expect(dialog).toContainText('選んだ画像 1枚のタグ、メモ、評価を削除します。元に戻せません。')
  await page.screenshot({ path: 'test-results/missing-confirm.png' })
  await dialog.getByRole('button', { name: '外す' }).click()
  await expect(status).toContainText('完了：DBから外した 1枚')
  await expect(thumbs(page)).toHaveCount(1)
  await expect(missingItem).toContainText('1')

  // 手動の差分検出。押すと同じく結果を出す
  await sidebar.getByRole('button', { name: '差分を確認' }).click()
  await expect(status).toContainText('完了：差分を反映')
  expect(errors).toEqual([])
})

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
