import { expect, test } from './fixtures'
import { openGallery, thumb, selectedNames } from './gallery-helpers'

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
  await expect(zoom.getByRole('img', { name: 'ref_00002.jpg' })).toHaveAttribute(
    'src',
    /#\/Users\/me\/Pictures\/Kura ライブラリ\/_未分類\/ref_00002\.jpg$/,
  )
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

  // 詳細パネルのサムネイルをダブルクリックしても開く（Finder と同じ）
  await detail.getByRole('img', { name: 'ref_00001.jpg のプレビュー' }).dblclick()
  await expect(zoom.getByRole('img')).toHaveAccessibleName('ref_00001.jpg')
  expect(errors).toEqual([])
})

test('拡大表示の中で拡大・縮小し、ドラッグと2本指で動かし、前後の画像へ移ると枠に合わせた大きさに戻る', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const zoom = page.getByRole('region', { name: '拡大表示' })
  const image = zoom.getByRole('img')
  const percent = page.locator('.toolbar__zoom-value')
  await thumb(page, 2).dblclick()

  // 帯には、サムネイルの大きさではなく画像の倍率のスライダーと、虫眼鏡の − ＋ を出す
  await expect(page.getByRole('slider', { name: 'サムネイルの大きさ' })).toHaveCount(0)
  await expect(page.getByRole('slider', { name: '画像の倍率' })).toBeVisible()
  const fitted = await percent.textContent()
  const fitBox = (await image.boundingBox())!
  await page.screenshot({ path: 'test-results/zoom-fit.png' })

  // ⌘0 で原寸、⌘9 で枠に合わせた大きさ
  await page.keyboard.press('Meta+0')
  await expect(percent).toHaveText('100%')
  await page.keyboard.press('Meta+9')
  await expect(percent).toHaveText(fitted!)

  // ＋ と ⌘＋ で大きくする。中央を保ったまま大きくなる
  await page.getByRole('button', { name: '拡大' }).click()
  await page.keyboard.press('Meta+=')
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitBox.width * 1.25 * 1.25, 0)
  await page.screenshot({ path: 'test-results/zoom-in.png' })

  // ドラッグで動かす。< > のボタンの上から始めても、前後の画像へは移らない
  const before = (await image.boundingBox())!
  const area = (await zoom.boundingBox())!
  const start = { x: area.x + area.width - 20, y: area.y + area.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x - 30, start.y - 20, { steps: 3 })
  await page.mouse.up()
  await expect(image).toHaveAccessibleName('ref_00002.jpg')
  const dragged = (await image.boundingBox())!
  expect(dragged.x).toBeCloseTo(before.x - 30, 0)

  // 2本指のスクロールでも動かす
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
  await page.mouse.wheel(0, 15)
  await expect.poll(async () => (await image.boundingBox())!.y).toBeCloseTo(dragged.y - 15, 0)

  // − と ⌘− で小さくする
  await page.keyboard.press('Meta+-')
  await page.getByRole('button', { name: '縮小' }).click()
  await expect(percent).toHaveText(fitted!)

  // 前後の画像へ移ると、枠に合わせた大きさに戻る
  await page.keyboard.press('Meta+=')
  await page.keyboard.press('ArrowRight')
  await expect(image).toHaveAccessibleName('ref_00003.jpg')
  const next = await percent.textContent()
  await page.keyboard.press('Meta+9')
  await expect(percent).toHaveText(next!)

  // 閉じると、サムネイルの大きさのスライダーに戻る
  await page.keyboard.press('Escape')
  await expect(page.getByRole('slider', { name: 'サムネイルの大きさ' })).toBeVisible()
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
  await expect(detail).toContainText('画像を選ぶと、ここに詳細が出ます')

  await thumb(page, 2).dblclick()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: '拡大表示' })).toHaveCount(0)
  expect(await selectedNames(page)).toEqual(['ref_00002.jpg'])

  await detail.getByRole('textbox', { name: 'メモ' }).press('Escape')
  expect(await selectedNames(page)).toEqual(['ref_00002.jpg'])
})
