import { expect, test } from './fixtures'
import { openGallery, thumb, selectedNames } from './gallery-helpers'

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
  await expect(category).toHaveValue('未分類')
  await expect(detail.getByRole('listitem')).toHaveText(['あおり', '座り'])
  await expect(detail).toContainText('元URLhttps://example.com/gallery/pose')
  await expect(detail).toContainText(/JPEG ・ \d+ × \d+ ・ 177 KB/)
  await expect(detail).toContainText(/取り込み日\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)
  await expect(detail).toContainText('腕の角度と')
  expect(await selectedNames(page)).toEqual(['ref_00001.jpg'])
  await page.screenshot({ path: 'test-results/detail.png' })

  // カテゴリは親からの道筋で出し、タグ・元URL・メモがなければ「なし」と出す
  await thumb(page, 2).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00002.jpg')
  await expect(category).toHaveValue('ポーズ / 座り')
  await expect(detail).toContainText('タグなし元URLなし')
  expect(errors).toEqual([])
})

test('詳細パネルの元URLはリンクになり、押すと既定のブラウザへ渡し、開けない値はリンクにしない（FR-208）', async ({
  page,
}) => {
  const opened: string[] = []
  page.on('console', (m) => m.text().startsWith('browser: ') && opened.push(m.text()))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })

  // 掲載ページURLを優先して出し、押すと確認なしで開く
  await thumb(page, 1).click()
  await detail.getByRole('link', { name: 'https://example.com/gallery/pose' }).click()
  await expect.poll(() => opened).toEqual(['browser: https://example.com/gallery/pose'])
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // 掲載ページURLがなければ画像URLを出す。開けなかったら、詳細パネルにエラーを出す
  await thumb(page, 3).click()
  await detail.getByRole('link', { name: 'https://example.com/images/ref_00003.jpg' }).click()
  await expect(detail).toContainText('エラー：ブラウザで開けません（exit status: 1）')
  await page.screenshot({ path: 'test-results/detail-source-url.png' })

  // 別の画像へ移ったら、前の画像のエラーを残さない。HTTP・HTTPS 以外の値は文字として出すだけにする
  await thumb(page, 4).click()
  await expect(detail).toContainText('元URLftp://example.com/images/ref_00004.jpg')
  await expect(detail).not.toContainText('ブラウザで開けません')
  await expect(detail.getByRole('link')).toHaveCount(0)

  // 元URLがなければ「なし」
  await thumb(page, 2).click()
  await expect(detail).toContainText('元URLなし')
  await expect(detail.getByRole('link')).toHaveCount(0)
  expect(opened).toHaveLength(1)
})

test('詳細パネルは滑り出てから外れ、滑り出る間はフォーカスを受けない。動きを減らす設定ではすぐ切り替える', async ({
  page,
}) => {
  await openGallery(page)
  // 閉じる動きの間は inert で読み上げの木から外れるので、役割ではなく要素で探す
  const detail = page.locator('aside[aria-label="詳細"]')
  const toggle = page.locator('button[aria-pressed][title*="⌘I"]')

  // 動きの途中を確かめるため、テストの中だけ動きを長くする
  await page.addStyleTag({ content: ':root { --duration-panel: 2s }' })
  await page.keyboard.press('Meta+i')
  // 閉じる動きの間はパネルが残り、中に入れない
  await expect(detail).toHaveCount(1)
  expect(await detail.evaluate((e) => e.closest('[inert]') !== null)).toBe(true)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(detail).toHaveCount(0)
  await page.keyboard.press('Meta+i')
  await expect(page.locator('.gallery--detail-opening')).toHaveCount(1)
  await expect(page.locator('.gallery--detail-opening')).toHaveCount(0)
  await expect(detail).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('Meta+i')
  expect(await detail.count()).toBe(0)
  await page.keyboard.press('Meta+i')
  expect(await detail.count()).toBe(1)
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

test('タグの入力欄の下に、この起動の間に付けたタグを新しい順に5個まで出し、押すと付ける', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const tagInput = detail.getByRole('combobox', { name: 'タグ' })
  const chips = detail.locator('.tag')
  const recent = detail.getByRole('list', { name: '最近使ったタグ' })

  // まだ付けていないので出さない
  await thumb(page, 2).click()
  await expect(recent).toHaveCount(0)

  for (const name of ['あ', 'い', 'う', 'え', 'お', 'か']) {
    await tagInput.fill(name)
    await tagInput.press('Enter')
  }
  // 選んだ画像に付いているタグは出さない
  await expect(recent).toHaveCount(0)

  // 別の画像では、新しい順に5個まで出す
  await thumb(page, 3).click()
  await expect(recent.getByRole('button')).toHaveText(['か', 'お', 'え', 'う', 'い'])
  await page.screenshot({ path: 'test-results/recent-tags.png' })

  // 押すと付け、付いたタグは候補から外れて次のタグが出る
  await recent.getByRole('button', { name: 'え' }).click()
  await expect(chips).toHaveText(['え'])
  await expect(recent.getByRole('button')).toHaveText(['か', 'お', 'う', 'い', 'あ'])
  expect(errors).toEqual([])
})

test('詳細パネルで入力したメモと評価を保存する', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const pressed = () =>
    detail
      .getByRole('button', { name: /^評価/ })
      .evaluateAll((bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').length)
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
