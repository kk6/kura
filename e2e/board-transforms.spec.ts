import { expect, test, type Locator, type Page } from '@playwright/test'
import { boardWith, box, center, drag, selectedIds, stored } from './board-helpers'

// ボードの反転・回転・グレースケール・トリミング（FR-706、FR-708、FR-704）

type Transformed = {
  x: number
  y: number
  rotation: number
  flipped: boolean
  grayscale: boolean
  crop: { x: number; y: number; width: number; height: number } | null
}
const geometry = async (page: Page, n = 0) => (await stored(page)).items[n].geometry as unknown as Transformed
const all = async (page: Page) => (await stored(page)).items

async function pick(page: Page, item: Locator, name: string) {
  await item.click({ button: 'right' })
  await page.getByRole('menu').getByText(name, { exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

const near = (actual: { x: number; y: number; width: number; height: number }, expected: typeof actual) => {
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(actual[k] - expected[k]), `${k}: ${actual[k]} と ${expected[k]}`).toBeLessThan(1.5)
}

test('左右反転とグレースケールを1枚ずつ別々に切り替え、保存し、取り消せる', async ({ page }) => {
  await boardWith(page, 1)
  // 同じ画像をもう1度追加する。加工は配置ごとで、同じ画像の別の配置には及ばない
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await page.locator('.list__thumb').nth(0).click()
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  await page.goto('/?board')
  const canvas = page.getByRole('main', { name: /キャンバス/ })
  const items = canvas.getByRole('img')
  await expect(items).toHaveCount(2)
  await page.getByRole('button', { name: '全体を表示' }).click()
  const before = await all(page)
  expect(before[1].source.image_id).toBe(before[0].source.image_id)
  const image = items.nth(0).locator('img')
  const place = await box(items.nth(0))

  await pick(page, items.nth(0), '左右反転')
  await expect.poll(async () => (await geometry(page)).flipped).toBe(true)
  expect((await geometry(page)).grayscale).toBe(false)
  await expect(image).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)')
  await expect(image).toHaveCSS('filter', 'none')

  await pick(page, items.nth(0), 'グレースケール')
  await expect.poll(async () => (await geometry(page)).grayscale).toBe(true)
  expect((await geometry(page)).flipped).toBe(true)
  await expect(image).toHaveCSS('filter', 'grayscale(1)')
  await page.screenshot({ path: 'test-results/board-flipped-grayscale.png' })

  // 反転だけを戻しても、グレースケールは残る
  await pick(page, items.nth(0), '左右反転')
  await expect.poll(async () => (await geometry(page)).flipped).toBe(false)
  expect((await geometry(page)).grayscale).toBe(true)
  await pick(page, items.nth(0), '左右反転')
  await expect.poll(async () => (await geometry(page)).flipped).toBe(true)

  // 置いた所と大きさ、同じ画像の別の配置は変わらない
  near(await box(items.nth(0)), place)
  const after = await all(page)
  expect(after[1]).toEqual(before[1])
  await expect(items.nth(1).locator('img')).toHaveCSS('transform', 'none')
  await expect(items.nth(1).locator('img')).toHaveCSS('filter', 'none')

  // メニューに今の状態が出る
  await items.nth(0).click({ button: 'right' })
  await expect(page.getByRole('menuitemcheckbox', { name: '左右反転' })).toBeChecked()
  await expect(page.getByRole('menuitemcheckbox', { name: 'グレースケール' })).toBeChecked()
  await page.keyboard.press('Escape')

  // 開き直しても同じ
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await page.reload()
  await expect(image).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)')
  await expect(image).toHaveCSS('filter', 'grayscale(1)')
  await expect(items.nth(1).locator('img')).toHaveCSS('filter', 'none')

  // 開き直すと履歴は消えるので、もう1度変えてから取り消す・やり直す
  await pick(page, items.nth(0), 'グレースケール')
  await expect.poll(async () => (await geometry(page)).grayscale).toBe(false)
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await geometry(page)).grayscale).toBe(true)
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(async () => (await geometry(page)).grayscale).toBe(false)
  expect((await geometry(page)).flipped).toBe(true)
})

test('加工の項目は、1枚を選んだときだけ押せる', async ({ page }) => {
  const { canvas, items } = await boardWith(page, 2)
  const before = await all(page)
  await items.nth(0).click()
  await items.nth(1).click({ modifiers: ['Meta'] })
  await expect(canvas.locator('.board__handle--rotate')).toHaveCount(0)
  await items.nth(0).click({ button: 'right' })
  for (const name of ['左右反転', 'グレースケール'])
    await expect(page.getByRole('menuitemcheckbox', { name })).toBeDisabled()
  for (const name of ['右へ90度回転', '回転をリセット', 'トリミング', 'トリミングを解除'])
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')

  // 1枚でも、回していなければリセットは押せず、切り抜いていなければ解除は押せない
  await items.nth(0).click()
  await expect(canvas.locator('.board__handle--rotate')).toHaveCount(1)
  await items.nth(0).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '右へ90度回転' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: '回転をリセット' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'トリミング', exact: true })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'トリミングを解除' })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await all(page)).toEqual(before)
})

test('ハンドルのドラッグで自由に回し、Shift で15度刻みにし、右へ90度回転とリセットができる', async ({ page }) => {
  const { canvas, items } = await boardWith(page, 2)
  const before = await all(page)
  const handle = canvas.locator('.board__handle--rotate')
  await items.nth(0).click()
  const middle = center(await box(items.nth(0)))

  // 途中で何度も動かしても、ドラッグ1回は1つの操作
  const from = center(await box(handle))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let n = 1; n <= 6; n++) await page.mouse.move(from.x + n * 9, from.y + n * 3)
  await page.mouse.up()
  await expect.poll(async () => (await geometry(page)).rotation).not.toBe(0)
  const free = (await geometry(page)).rotation
  expect(free).toBeGreaterThan(5)
  expect(free).toBeLessThan(85)
  expect(free % 15).not.toBe(0)
  // 回しても中心は動かず、選択枠は回した後の画像を囲む
  const turned = await box(items.nth(0))
  near({ ...center(turned), width: 0, height: 0 }, { ...middle, width: 0, height: 0 })
  near((await canvas.locator('.board__frame').boundingBox())!, turned)
  await page.screenshot({ path: 'test-results/board-rotated.png' })
  await page.keyboard.press('Meta+z')
  await expect.poll(() => all(page)).toEqual(before)
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(async () => (await geometry(page)).rotation).toBe(free)

  // Shift を押してハンドルを引く。15度刻みになり、Shift＋クリックの選択の解除にはならない
  const again = center(await box(handle))
  await page.keyboard.down('Shift')
  await drag(page, again, { x: again.x + 70, y: again.y + 40 })
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await geometry(page)).rotation).not.toBe(free)
  const snapped = (await geometry(page)).rotation
  expect(snapped % 15).toBe(0)
  expect(await selectedIds(canvas)).toEqual([before[0].id])

  await pick(page, items.nth(0), '右へ90度回転')
  await expect.poll(async () => (await geometry(page)).rotation).toBe((snapped + 90) % 360)
  await pick(page, items.nth(0), '回転をリセット')
  await expect.poll(async () => (await geometry(page)).rotation).toBe(0)
  expect(await all(page)).toEqual(before)

  // 開き直しても同じ角度で出る
  await pick(page, items.nth(0), '右へ90度回転')
  await expect.poll(async () => (await geometry(page)).rotation).toBe(90)
  const upright = await box(items.nth(0))
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await page.reload()
  await expect(items).toHaveCount(2)
  near(await box(items.nth(0)), upright)
  expect((await all(page))[1]).toEqual(before[1])
})

test('回した配置でも、範囲選択と「選択画像を表示」が見えている形に合う', async ({ page }) => {
  const { canvas, items, area } = await boardWith(page, 1)
  await items.nth(0).click()
  const handle = center(await box(canvas.locator('.board__handle--rotate')))
  const flat = await box(items.nth(0))
  const middle = center(flat)
  // 上のハンドルを右下へ45度ぶん回す
  const reach = middle.y - handle.y
  await page.keyboard.down('Shift')
  await drag(page, handle, { x: middle.x + reach, y: middle.y - reach })
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await geometry(page)).rotation).toBe(45)
  const outer = await box(items.nth(0))
  await page.mouse.click(area.x + 10, area.y + 10)
  expect(await selectedIds(canvas)).toEqual([])

  // 外枠の左上の角は、画像のない所。そこだけを囲んでも選ばれない
  await drag(page, { x: outer.x - 20, y: outer.y - 20 }, { x: outer.x + 12, y: outer.y + 12 })
  expect(await selectedIds(canvas)).toEqual([])
  // 画像の角に掛かれば選ばれる
  const corner = middle.y + (flat.height - flat.width) / (2 * Math.SQRT2)
  await drag(page, { x: outer.x - 20, y: corner - 10 }, { x: outer.x + 12, y: corner + 10 })
  expect(await selectedIds(canvas)).toHaveLength(1)

  // 回した後の外枠の全体が、余白を空けてキャンバスに収まる
  await page.getByRole('button', { name: '選択画像を表示' }).click()
  const fitted = await box(items.nth(0))
  const margin = 48
  expect(fitted.x).toBeGreaterThanOrEqual(area.x + margin - 1.5)
  expect(fitted.y).toBeGreaterThanOrEqual(area.y + margin - 1.5)
  expect(fitted.x + fitted.width).toBeLessThanOrEqual(area.x + area.width - margin + 1.5)
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(area.y + area.height - margin + 1.5)
  // 縦か横のどちらかは、余白までいっぱいに使う
  const slack = Math.min(fitted.x - area.x - margin, fitted.y - area.y - margin)
  expect(Math.abs(slack)).toBeLessThan(1.5)
  near((await canvas.locator('.board__frame').boundingBox())!, fitted)
})

test('四角形でトリミングし、反転・回転した配置でも範囲を選べ、解除で元の全体に戻る', async ({ page }) => {
  const { canvas, items, area } = await boardWith(page, 2)
  const hint = canvas.getByText('切り抜く範囲をドラッグ')
  // 回した後の元画像の全体が画面に収まるよう、先に表示を縮める
  const shown = (await stored(page)).viewport!.scale
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await stored(page)).viewport!.scale).toBeLessThan(shown)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const before = await all(page)
  const full = await box(items.nth(0))

  // Esc と、引かずに離したときは、何も変えずにやめる
  await pick(page, items.nth(0), 'トリミング')
  await expect(hint).toBeVisible()
  await expect(canvas.locator('.board__handle')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(hint).toHaveCount(0)
  await pick(page, items.nth(0), 'トリミング')
  await page.mouse.click(full.x + 5, full.y + 5)
  await expect(hint).toHaveCount(0)
  expect(await all(page)).toEqual(before)

  // 右半分を、画像の外まで引いて選ぶ。外の分は切り捨てる
  await pick(page, items.nth(0), 'トリミング')
  await drag(
    page,
    { x: full.x + full.width / 2, y: full.y - 20 },
    { x: full.x + full.width + 20, y: full.y + full.height + 20 },
  )
  await expect.poll(async () => (await geometry(page)).crop).not.toBeNull()
  await expect(hint).toHaveCount(0)
  const right = (await geometry(page)).crop!
  expect(right.x).toBeCloseTo(0.5, 2)
  expect(right.y).toBe(0)
  expect(right.x + right.width).toBe(1)
  expect(right.height).toBe(1)
  // 残した部分は、切り抜く前と同じ所に見える
  const half = { x: full.x + full.width / 2, y: full.y, width: full.width / 2, height: full.height }
  near(await box(items.nth(0)), half)
  near((await canvas.locator('.board__frame').boundingBox())!, half)
  await page.screenshot({ path: 'test-results/board-cropped.png' })

  // 反転しても回しても、見えている部分はその場に残る
  await pick(page, items.nth(0), '左右反転')
  await expect.poll(async () => (await geometry(page)).flipped).toBe(true)
  near(await box(items.nth(0)), half)
  await pick(page, items.nth(0), '右へ90度回転')
  await expect.poll(async () => (await geometry(page)).rotation).toBe(90)
  const lying = await box(items.nth(0))
  near(
    { ...center(lying), width: lying.width, height: lying.height },
    { ...center(half), width: half.height, height: half.width },
  )
  expect((await geometry(page)).crop).toEqual(right)

  // 反転して回した配置で選び直す。選ぶ間は元画像の全体が出る
  await pick(page, items.nth(0), 'トリミング')
  await expect(hint).toBeVisible()
  const whole = await box(items.nth(0))
  expect(whole.height).toBeGreaterThan(lying.height * 1.9)
  // 画面の下半分は、右へ90度回す前の右半分。反転しているので、元画像では左半分にあたる
  const low = { x: whole.x, y: whole.y + whole.height / 2, width: whole.width, height: whole.height / 2 }
  await drag(page, { x: low.x - 20, y: low.y }, { x: low.x + low.width + 20, y: low.y + low.height + 20 })
  await expect.poll(async () => (await geometry(page)).crop?.x).toBe(0)
  const left = (await geometry(page)).crop!
  expect(left.width).toBeCloseTo(0.5, 2)
  expect([left.y, left.height]).toEqual([0, 1])
  near(await box(items.nth(0)), low)
  await page.screenshot({ path: 'test-results/board-cropped-rotated.png' })

  // 解除すると、元画像の全体が、選び直すときに見えていた所に出る
  await pick(page, items.nth(0), 'トリミングを解除')
  await expect.poll(async () => (await geometry(page)).crop).toBeNull()
  near(await box(items.nth(0)), whole)
  expect((await geometry(page)).flipped).toBe(true)
  expect((await geometry(page)).rotation).toBe(90)

  // 取り消し・やり直しと、開き直し
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await geometry(page)).crop).toEqual(left)
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await geometry(page)).crop).toEqual(right)
  await page.keyboard.press('Shift+Meta+z')
  await expect.poll(async () => (await geometry(page)).crop).toEqual(left)
  await expect(page.getByRole('status')).toHaveText('保存済み')
  await page.reload()
  await expect(items).toHaveCount(2)
  near(await box(items.nth(0)), low)

  // ほかの配置は変わらない
  expect((await all(page))[1]).toEqual(before[1])
})
