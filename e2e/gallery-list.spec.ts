import { expect, test } from './fixtures'
import { openGallery, thumbs, columnCount } from './gallery-helpers'

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
  await expect(sidebar.getByRole('list', { name: 'タグ' }).locator('.sidebar__name')).toHaveText([
    'あおり',
    '座り',
    '振り返り',
  ])
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

test('詳細パネルでタグやメモを変えても一覧のスクロールは先頭に戻らず、並べ替えると先頭に戻る', async ({ page }) => {
  await openGallery(page)
  const list = page.getByRole('main', { name: '画像の一覧' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  await list.evaluate((el) => (el.scrollTop = 3000))
  const scrolled = () => list.evaluate((el) => el.scrollTop)
  await expect.poll(scrolled).toBe(3000)

  // 一覧の枠の中ほどに見えているサムネイルを選ぶ
  const at = await list.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const img = Array.from(el.querySelectorAll('img')).find((i) => {
      const r = i.getBoundingClientRect()
      return r.top > box.top + 100 && r.bottom < box.bottom - 100
    })!
    const r = img.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(at.x, at.y)
  await expect(detail.getByRole('heading')).not.toHaveText(/枚を選んでいます/)

  const tagInput = detail.getByRole('combobox', { name: 'タグ' })
  await tagInput.fill('スクロール確認')
  await tagInput.press('Enter')
  await expect(detail.locator('.tag')).toContainText(['スクロール確認'])
  const memo = detail.getByRole('textbox', { name: 'メモ' })
  await memo.fill('メモ')
  await memo.blur()
  await expect(page.getByRole('contentinfo')).not.toContainText('エラー')
  expect(await scrolled()).toBe(3000)

  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  await expect.poll(scrolled).toBe(0)
})

test('スライダーでサムネイルを小さくすると列が増え、大きさは開き直しても残る。左右のアイコンで1段ずつ変え、拡大表示の間は隠す', async ({
  page,
}) => {
  await openGallery(page)
  const before = await columnCount(page)

  await page.getByRole('slider', { name: 'サムネイルの大きさ' }).fill('100')

  await expect.poll(() => columnCount(page)).toBeGreaterThan(before)
  await page.screenshot({ path: 'test-results/gallery-small.png' })
  const small = await columnCount(page)

  await openGallery(page)
  const slider = page.getByRole('slider', { name: 'サムネイルの大きさ' })
  await expect(slider).toHaveValue('100')
  await expect.poll(() => columnCount(page)).toBe(small)

  // 左右のアイコンは1段（10px）ずつ小さく・大きくする。最小では小さくするボタンを押せない
  const smaller = page.getByRole('button', { name: 'サムネイルを小さくする' })
  const larger = page.getByRole('button', { name: 'サムネイルを大きくする' })
  await expect(smaller).toBeDisabled()
  await larger.click()
  await expect(slider).toHaveValue('110')
  await smaller.click()
  await expect(slider).toHaveValue('100')

  // 拡大表示の間は、見えないサムネイルの大きさを変えないよう、スライダーとアイコンを隠す
  await thumbs(page).first().dblclick()
  await expect(page.getByRole('region', { name: '拡大表示' })).toBeVisible()
  await expect(slider).toHaveCount(0)
  await expect(larger).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(slider).toHaveValue('100')
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
