import { emit } from './board-helpers'
import { expect, test, type Page } from './fixtures'
import { settingsKind, thumbs } from './gallery-helpers'

// 元が同じ画像の組を探す（FR-611）とメニューの「似た画像を探す」（6章）。モックは20枚で、組は計算済みの画像の
// 先頭から 1〜2、3〜5、6〜7（src/mocks/ipc.ts の findOriginGroups）
const name = (id: number) => `ref_${String(id).padStart(5, '0')}.jpg`
const thumb = (page: Page, id: number) => thumbs(page).and(page.getByAltText(name(id), { exact: true }))
const toolbar = (page: Page) => page.locator('.gallery__toolbar')
const sections = (page: Page) => page.locator('.list__section')

async function open(page: Page, similarity = true, slow = false) {
  await page.addInitScript(
    ([similarity, slow]) => {
      if (slow) sessionStorage.setItem('mock.originSlow', '1')
      if (sessionStorage.getItem('mock.settings')) return
      sessionStorage.setItem(
        'mock.settings',
        JSON.stringify({
          confirm_category_move: true,
          thumb_width: 200,
          tags_collapsed: false,
          board_enabled: true,
          similarity_enabled: similarity,
          similarity_weights: {},
          board_window: { always_on_top: false, opacity: 100, frame: null },
        }),
      )
    },
    [similarity, slow],
  )
  await page.goto('/?images=20')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

test('メニューから組を探すと、探している間は進み具合を出し、中止すると結果を出さない', async ({ page }) => {
  await open(page, true, true)
  await emit(page, 'find-origin-groups')
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('元が同じ画像の組を探し中')
  await expect(page.getByRole('progressbar', { name: '元が同じ画像の組を探す進み具合' })).toBeVisible()
  await page.screenshot({ path: 'test-results/origin-progress.png' })
  // 探している間もほかの操作を続けられる
  await thumb(page, 3).click()
  await expect(page.locator('.list__thumb--selected')).toHaveCount(1)

  await status.getByRole('button', { name: '中止' }).click()
  await expect(status).not.toContainText('元が同じ画像の組を探し中')
  await expect(toolbar(page)).not.toContainText('元が同じ画像')
  await expect(sections(page)).toHaveCount(0)
})

test('組ごとに見出しの行で区切って並べ、外した組とまとめた組は一覧から消え、閉じると元の一覧に戻る', async ({
  page,
}) => {
  await open(page)
  await emit(page, 'find-origin-groups')
  await expect(toolbar(page)).toContainText('元が同じ画像')
  await expect(toolbar(page)).toContainText('3組')
  await expect(sections(page)).toHaveCount(3)
  await expect(sections(page).first()).toContainText('2枚')
  await expect(sections(page).nth(1)).toContainText('3枚')
  await expect(thumbs(page)).toHaveCount(7)
  // 2つ目の組の画像は、2つ目の見出しより下に並ぶ
  const header = await sections(page).nth(1).boundingBox()
  const image = await thumb(page, 3).boundingBox()
  expect(image!.y).toBeGreaterThan(header!.y + header!.height - 1)
  await page.screenshot({ path: 'test-results/origin-groups.png' })

  await sections(page).nth(2).getByRole('button', { name: '一覧から外す' }).click()
  await expect(toolbar(page)).toContainText('2組')
  await expect(thumbs(page)).toHaveCount(5)

  await sections(page).nth(1).getByRole('button', { name: '1枚にまとめる…' }).click()
  const dialog = page.getByRole('dialog', { name: /1枚にまとめる/ })
  await expect(dialog.getByRole('heading')).toHaveText('3枚を1枚にまとめる')
  await dialog.getByRole('button', { name: 'まとめる…' }).click()
  await dialog.getByRole('button', { name: 'ゴミ箱へ移す' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(toolbar(page)).toContainText('1組')
  await expect(thumbs(page)).toHaveCount(2)

  await toolbar(page).getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(sections(page)).toHaveCount(0)
  await expect(toolbar(page)).toContainText('すべての画像')
})

test('絞り込みは、条件に合う画像を1枚でも含む組を組ごと出す。組がなければそう知らせる', async ({ page }) => {
  await open(page)
  await emit(page, 'find-origin-groups')
  await expect(sections(page)).toHaveCount(3)
  await page.getByRole('combobox', { name: '検索' }).fill(name(4))
  await expect(sections(page)).toHaveCount(1)
  await expect(thumbs(page)).toHaveCount(3)
  await page.getByRole('combobox', { name: '検索' }).fill('')

  for (let i = 0; i < 3; i++) await sections(page).first().getByRole('button', { name: '一覧から外す' }).click()
  await expect(page.getByText('元が同じ画像の組は見つかりませんでした')).toBeVisible()
})

test('設定の「類似画像検索」の「探す」で、設定を閉じて組を出す', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '設定' }).click()
  await settingsKind(page, '類似画像検索')
  await page.getByRole('button', { name: '探す', exact: true }).click()
  await expect(toolbar(page)).toContainText('3組')
})

test('メニューの「似た画像を探す」は、1枚を選んでいるときだけ詳細パネルのボタンと同じに効き、入力欄の中では効かない', async ({
  page,
}) => {
  const reports: string[] = []
  page.on('console', (m) => m.text().startsWith('report_gallery') && reports.push(m.text()))
  await open(page)
  await emit(page, 'find-similar')
  await expect(toolbar(page)).not.toContainText('似た画像')

  await thumb(page, 1).click()
  // 詳細を読んで基準にできると分かってから、メニューを有効にする
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: true true false')
  await page.locator('#detail-memo').click()
  await emit(page, 'find-similar')
  await page.waitForTimeout(200)
  await expect(toolbar(page)).not.toContainText('似た画像')

  await page.locator('#detail-memo').blur()
  await emit(page, 'find-similar')
  await expect(toolbar(page)).toContainText('似た画像')
})

test('類似画像検索が OFF の間は、メニューのイベントが届いても探さない', async ({ page }) => {
  const reports: string[] = []
  page.on('console', (m) => m.text().startsWith('report_gallery') && reports.push(m.text()))
  await open(page, false)
  await thumb(page, 1).click()
  await expect.poll(() => reports.at(-1)).toBe('report_gallery: true false false')
  await emit(page, 'find-similar')
  await emit(page, 'find-origin-groups')
  await page.waitForTimeout(300)
  await expect(toolbar(page)).toContainText('すべての画像')
  await expect(page.getByRole('contentinfo')).not.toContainText('元が同じ画像の組を探し中')
})
