import { expect, test, type Locator } from '@playwright/test'
import { boardWith, box, center, drag, emit, selectedIds, stored, type Geometry } from './board-helpers'

// ボードのキャンバスの操作（FR-702、FR-703、FR-704）。選択、移動、拡大・縮小、配置を外す、パン、ズーム、表示の保存

test('クリック、⌘＋クリックと Shift＋クリック、空白からのドラッグ、⌘A で配置を選ぶ', async ({ page }) => {
  const { canvas, items, blank } = await boardWith(page, 3)
  const ids = (await stored(page)).items.map((i) => i.id)
  const [a, b, c] = await Promise.all([box(items.nth(0)), box(items.nth(1)), box(items.nth(2))])

  await items.nth(0).click()
  expect(await selectedIds(canvas)).toEqual([ids[0]])
  await items.nth(1).click({ modifiers: ['Meta'] })
  await items.nth(2).click({ modifiers: ['Shift'] })
  expect(await selectedIds(canvas)).toEqual(ids)
  // どちらのキーでも、選んである配置を押すと外れる
  await items.nth(0).click({ modifiers: ['Shift'] })
  await items.nth(1).click({ modifiers: ['Meta'] })
  expect(await selectedIds(canvas)).toEqual([ids[2]])
  await items.nth(1).click()
  expect(await selectedIds(canvas)).toEqual([ids[1]])
  await page.mouse.click(blank.x, blank.y)
  expect(await selectedIds(canvas)).toEqual([])

  // 空白から引いた枠に少しでも入った配置を選ぶ
  await page.mouse.move(a.x - 20, a.y - 20)
  await page.mouse.down()
  await page.mouse.move(a.x + 10, a.y + 10)
  await page.mouse.move(center(b).x, center(b).y)
  await expect(canvas.locator('.board__marquee')).toBeVisible()
  await page.screenshot({ path: 'test-results/board-marquee.png' })
  await page.mouse.up()
  await expect(canvas.locator('.board__marquee')).toHaveCount(0)
  expect(await selectedIds(canvas)).toEqual([ids[0], ids[1]])

  // Shift を押しながら引くと、今の選択に足す
  await page.keyboard.down('Shift')
  await drag(page, { x: c.x - 20, y: c.y + c.height + 20 }, center(c))
  await page.keyboard.up('Shift')
  expect(await selectedIds(canvas)).toEqual(ids)

  await page.mouse.click(blank.x, blank.y)
  await page.keyboard.press('Meta+a')
  expect(await selectedIds(canvas)).toEqual(ids)
  // 選ぶだけでは配置は変わらない
  expect((await stored(page)).items.map((i) => i.id)).toEqual(ids)
})

test('複数を選んでドラッグすると相互の位置を保って動き、動かさずに離すと押した1枚だけを選ぶ', async ({ page }) => {
  const { canvas, items } = await boardWith(page, 3)
  const before = (await stored(page)).items
  await items.nth(0).click()
  await items.nth(1).click({ modifiers: ['Meta'] })

  const from = center(await box(items.nth(0)))
  await drag(page, from, { x: from.x + 60, y: from.y + 40 })
  await expect.poll(async () => (await stored(page)).items[0].geometry.x).toBeGreaterThan(before[0].geometry.x)
  const after = (await stored(page)).items
  const moved = (n: number) => ({
    x: after[n].geometry.x - before[n].geometry.x,
    y: after[n].geometry.y - before[n].geometry.y,
  })
  expect(moved(0).y).toBeGreaterThan(0)
  expect(moved(1).x).toBeCloseTo(moved(0).x)
  expect(moved(1).y).toBeCloseTo(moved(0).y)
  expect(after[2].geometry).toEqual(before[2].geometry)
  expect(after.map((i) => i.geometry.scale)).toEqual(before.map((i) => i.geometry.scale))
  expect(await selectedIds(canvas)).toEqual([before[0].id, before[1].id])
  await page.screenshot({ path: 'test-results/board-moved-group.png' })

  await items.nth(1).click()
  expect(await selectedIds(canvas)).toEqual([before[1].id])
  expect((await stored(page)).items).toEqual(after)
})

test('四隅のハンドルで、1枚でも複数でも縦横比と相互の位置を保って拡大・縮小する', async ({ page }) => {
  const { canvas, items } = await boardWith(page, 3)
  const before = (await stored(page)).items

  // 1枚。右下を引くと左上は動かない
  await items.nth(0).click()
  const se = center(await box(canvas.locator('.board__handle--se')))
  await drag(page, se, { x: se.x + 50, y: se.y + 20 })
  await expect.poll(async () => (await stored(page)).items[0].geometry.scale).toBeGreaterThan(before[0].geometry.scale)
  const single = (await stored(page)).items
  expect(single[0].geometry.x).toBeCloseTo(before[0].geometry.x)
  expect(single[0].geometry.y).toBeCloseTo(before[0].geometry.y)
  expect([single[0].geometry.width, single[0].geometry.height]).toEqual([
    before[0].geometry.width,
    before[0].geometry.height,
  ])
  expect(single.slice(1)).toEqual(before.slice(1))

  // 複数。左上を外へ引くと、右下を基準に同じ倍率で大きくなる
  await items.nth(1).click({ modifiers: ['Shift'] })
  await expect(canvas.locator('.board__frame--outlined')).toBeVisible()
  const nw = center(await box(canvas.locator('.board__handle--nw')))
  await drag(page, nw, { x: nw.x - 40, y: nw.y - 40 })
  await expect.poll(async () => (await stored(page)).items[1].geometry.scale).toBeGreaterThan(single[1].geometry.scale)
  const group = (await stored(page)).items
  const factor = group[1].geometry.scale / single[1].geometry.scale
  expect(group[0].geometry.scale / single[0].geometry.scale).toBeCloseTo(factor)
  expect(group[1].geometry.x - group[0].geometry.x).toBeCloseTo((single[1].geometry.x - single[0].geometry.x) * factor)
  expect(group[1].geometry.y - group[0].geometry.y).toBeCloseTo((single[1].geometry.y - single[0].geometry.y) * factor)
  const right = (g: Geometry) => g.x + g.width * g.scale
  expect(Math.max(right(group[0].geometry), right(group[1].geometry))).toBeCloseTo(
    Math.max(right(single[0].geometry), right(single[1].geometry)),
  )
  expect(group[2]).toEqual(before[2])
  await page.screenshot({ path: 'test-results/board-resized.png' })
})

test('Delete は選んだ配置だけを外し、入力欄とダイアログでのキーは配置に効かない', async ({ page }) => {
  await boardWith(page, 2)
  // 同じ画像をもう1度追加する
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await page.locator('.list__thumb').nth(0).click()
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  await page.goto('/?board')
  const canvas = page.getByRole('main', { name: /キャンバス/ })
  const items = canvas.getByRole('img')
  await expect(items).toHaveCount(3)
  const before = (await stored(page)).items
  expect(before[2].source.image_id).toBe(before[0].source.image_id)
  // 追加の直後は追加分だけが見えている
  await page.getByRole('button', { name: '全体を表示' }).click()

  // Mac の delete キー（Backspace）。同じ画像の別の配置は残る
  await items.nth(0).click()
  await page.keyboard.press('Backspace')
  await expect(items).toHaveCount(2)
  await expect(canvas.locator('.board__item--selected')).toHaveCount(0)
  await expect.poll(async () => (await stored(page)).items).toEqual(before.slice(1))

  await items.nth(0).click()
  await page.keyboard.press('Delete')
  await expect(items).toHaveCount(1)
  await expect.poll(async () => (await stored(page)).items).toEqual(before.slice(2))

  // 何も選んでいなければ何もしない
  await page.keyboard.press('Backspace')
  await expect(items).toHaveCount(1)

  // 名前の入力欄では、文字の編集だけに効く
  await items.nth(0).click()
  await page.getByRole('button', { name: 'ボードの操作' }).click()
  await page.getByRole('menuitem', { name: '名前を変更…' }).click()
  const name = page.getByRole('dialog').getByRole('textbox')
  await name.fill('abc')
  await name.press('Backspace')
  await name.press('Space')
  await name.press('Meta+a')
  await name.press('Delete')
  await name.pressSequentially('x y')
  await expect(name).toHaveValue('x y')
  // ダイアログのボタンにフォーカスがあっても効かない
  // （ここで Backspace を使うと、履歴のあるテストのブラウザは前のページへ戻る。実アプリのウィンドウには戻る先がない）
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).focus()
  await page.keyboard.press('Delete')
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()
  await expect(items).toHaveCount(1)
  await expect(canvas.locator('.board__item--selected')).toHaveCount(1)

  // ボードの選択欄でも効かない
  await page.getByRole('combobox', { name: 'ボード' }).focus()
  await page.keyboard.press('Delete')
  await expect(items).toHaveCount(1)

  // 削除の確認は、外した後の件数を示す
  await page.getByRole('button', { name: 'ボードの操作' }).click()
  await page.getByRole('menuitem', { name: '削除…' }).click()
  await expect(page.getByRole('dialog', { name: 'ボードを削除' })).toContainText('置いた画像 1枚')
  expect((await stored(page)).items).toEqual(before.slice(2))
})

test('Space＋ドラッグと中ボタンのドラッグは表示を動かし、範囲選択や配置の移動にならない。表示は開き直すと戻る', async ({
  page,
}) => {
  const { canvas, items } = await boardWith(page, 2)
  const before = await stored(page)
  const a = await box(items.nth(0))

  // 空白から配置の上を通って引く。範囲選択なら配置が選ばれる
  await page.keyboard.down('Space')
  await drag(page, { x: a.x - 20, y: a.y - 20 }, { x: a.x + 60, y: a.y + 30 })
  const panned = await box(items.nth(0))
  expect(panned.x - a.x).toBeCloseTo(80, 0)
  expect(panned.y - a.y).toBeCloseTo(50, 0)
  expect(await selectedIds(canvas)).toEqual([])
  await expect(canvas.locator('.board__marquee')).toHaveCount(0)

  // 配置の上から引いても、配置は動かず選ばれない
  await drag(page, center(panned), { x: center(panned).x - 30, y: center(panned).y + 10 })
  await page.keyboard.up('Space')
  expect((await box(items.nth(0))).x - panned.x).toBeCloseTo(-30, 0)
  expect(await selectedIds(canvas)).toEqual([])

  const mid = await box(items.nth(0))
  await drag(page, center(mid), { x: center(mid).x + 20, y: center(mid).y + 20 }, 'middle')
  expect((await box(items.nth(0))).x - mid.x).toBeCloseTo(20, 0)
  expect(await selectedIds(canvas)).toEqual([])

  // 表示だけが保存され、配置は変わらない
  await expect
    .poll(async () => (await stored(page)).viewport!.x)
    .toBeCloseTo(before.viewport!.x - 70 / before.viewport!.scale, 0)
  expect((await stored(page)).items).toEqual(before.items)

  // Space を離すと、空白からのドラッグは範囲選択に戻る
  const last = await box(items.nth(0))
  await drag(page, { x: last.x - 20, y: last.y - 20 }, center(last))
  expect(await selectedIds(canvas)).toEqual([before.items[0].id])

  await page.reload()
  await expect(items).toHaveCount(2)
  const reopened = await box(items.nth(0))
  expect(reopened.x).toBeCloseTo(last.x, 0)
  expect(reopened.y).toBeCloseTo(last.y, 0)
})

test('ホイールとピンチはポインターの位置を中心に拡大・縮小し、「全体を表示」「選択画像を表示」で戻れる', async ({
  page,
}) => {
  const { canvas, items, area } = await boardWith(page, 3)
  const before = await stored(page)
  const fitAll = page.getByRole('button', { name: '全体を表示' })
  const fitSelected = page.getByRole('button', { name: '選択画像を表示' })
  await expect(fitSelected).toBeDisabled()

  // ポインターを置いた配置の左上の角が、拡大しても同じ所に残る
  const a = await box(items.nth(0))
  await page.mouse.move(a.x, a.y)
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => (await box(items.nth(0))).width).toBeGreaterThan(a.width * 1.1)
  const zoomed = await box(items.nth(0))
  expect(zoomed.x).toBeCloseTo(a.x, 0)
  expect(zoomed.y).toBeCloseTo(a.y, 0)

  // ピンチ。WebKit はピンチを gesturechange で届ける。始めてからの倍率が 0.5 なら半分になる
  const b = await box(items.nth(1))
  await canvas.evaluate(
    (el, at) => {
      for (const [type, scale] of [
        ['gesturestart', 1],
        ['gesturechange', 0.8],
        ['gesturechange', 0.5],
      ] as const)
        el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, ...at }))
    },
    { clientX: b.x, clientY: b.y },
  )
  await expect.poll(async () => (await box(items.nth(1))).width).toBeCloseTo(b.width / 2, 0)
  const pinched = await box(items.nth(1))
  expect(pinched.x).toBeCloseTo(b.x, 0)
  expect(pinched.y).toBeCloseTo(b.y, 0)

  // 大きく拡大して画像を画面の外へ出しても、全体の表示に戻れる
  const inside = async (item: Locator) => {
    const r = await box(item)
    return (
      r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height
    )
  }
  await page.mouse.move(area.x + 5, area.y + 5)
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -100)
  await expect.poll(() => inside(items.nth(2))).toBe(false)
  await fitAll.click()
  for (const n of [0, 1, 2]) await expect.poll(() => inside(items.nth(n))).toBe(true)
  await page.screenshot({ path: 'test-results/board-fit-all.png' })

  // 選んだ1枚が、余白を空けてキャンバスいっぱいに見える
  await items.nth(2).click()
  await fitSelected.click()
  await expect
    .poll(async () => {
      const r = await box(items.nth(2))
      return Math.max(r.width / area.width, r.height / area.height)
    })
    .toBeGreaterThan(0.8)
  expect(await inside(items.nth(2))).toBe(true)
  await page.screenshot({ path: 'test-results/board-fit-selected.png' })

  // 表示だけが保存され、開き直すと同じ位置と倍率で出る
  const shown = await box(items.nth(2))
  await expect.poll(async () => (await stored(page)).viewport!.scale).toBeGreaterThan(before.viewport!.scale)
  expect((await stored(page)).items).toEqual(before.items)
  await page.reload()
  await expect(items).toHaveCount(3)
  const reopened = await box(items.nth(2))
  expect(reopened.x).toBeCloseTo(shown.x, 0)
  expect(reopened.width).toBeCloseTo(shown.width, 0)
})

test('閉じる前の保存待ちの間は、移動・配置を外す・選択・ズームを受け付けない', async ({ page }) => {
  const { canvas, items, blank } = await boardWith(page, 2)
  const before = await stored(page)
  await items.nth(0).click()
  const flushed: string[] = []
  page.on('console', (m) => m.text().startsWith('flush_done') && flushed.push(m.text()))
  await emit(page, 'flush', 1)
  await expect.poll(() => flushed).toEqual(['flush_done: ok'])

  const a = await box(items.nth(0))
  await drag(page, center(a), { x: center(a).x + 50, y: center(a).y + 50 })
  await page.keyboard.press('Backspace')
  await page.mouse.wheel(0, -100)
  await page.mouse.click(blank.x, blank.y)
  await drag(page, blank, center(await box(items.nth(1))))
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(500)
  await expect(items).toHaveCount(2)
  expect(await box(items.nth(0))).toEqual(a)
  expect(await selectedIds(canvas)).toEqual([before.items[0].id])
  expect(await stored(page)).toEqual(before)

  // 閉じるのをやめたら、また操作できる
  await emit(page, 'release')
  await page.keyboard.press('Backspace')
  await expect(items).toHaveCount(1)
  await expect.poll(async () => (await stored(page)).items).toEqual(before.items.slice(1))
})

// 測り終える前は大きさ 0 のキャンバスとして置かれ、開いた直後だけ配置が幅の半分ずれていた
test('キャンバスの大きさの通知が遅れても、開いた直後から配置を正しい位置に描く', async ({ page }) => {
  const { items } = await boardWith(page, 2)
  const shown = await box(items.nth(0))
  // ResizeObserver の最初の通知を届かせない
  await page.addInitScript(() => {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })
  await page.reload()
  await expect(items).toHaveCount(2)
  expect((await box(items.nth(0))).x).toBeCloseTo(shown.x, 0)
})
