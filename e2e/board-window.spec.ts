import { expect, test, type Page } from './fixtures'
import { boardWith } from './board-helpers'

// 最前面と不透明度がウィンドウに効くことは、モックでは確かめられない（実アプリで確かめる）。
// ここでは、操作部品の表示と、Rust へ送って保存する値を確かめる

const display = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.settings') ?? 'null')?.board_window ?? null)

test('最前面に固定と不透明度を変えると保存され、開き直しても残る。100%に戻せる（FR-705、FR-707）', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await boardWith(page, 1)
  const pin = page.getByRole('button', { name: '最前面に固定' })
  const opacity = page.getByRole('slider', { name: '不透明度' })
  const reset = page.getByRole('button', { name: '100%に戻す' })

  // 初期値は最前面 OFF、不透明度100%
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await expect(opacity).toHaveValue('100')
  await expect(opacity).toHaveAttribute('min', '30')
  await expect(reset).toBeDisabled()

  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  await opacity.fill('45')
  await expect(page.locator('.board__percent')).toHaveText('45%')
  await expect.poll(() => display(page)).toMatchObject({ always_on_top: true, opacity: 45 })
  await page.screenshot({ path: 'test-results/board-window-display.png' })

  // ウィンドウは閉じるたびに破棄される。開き直しても、ボードを切り替えても同じ値
  await page.reload()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  await expect(opacity).toHaveValue('45')

  // ギャラリーが前に読んだ設定を保存しても、ボードの表示は消えない（FR-711）
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await page.getByRole('button', { name: '設定' }).click()
  await page.getByRole('checkbox', { name: 'アイデアボードを使う' }).uncheck()
  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.settings')!).board_enabled))
    .toBe(false)
  expect(await display(page)).toMatchObject({ always_on_top: true, opacity: 45 })

  await page.goto('/?board')
  await reset.click()
  await expect(opacity).toHaveValue('100')
  await expect(reset).toBeDisabled()
  await expect.poll(() => display(page)).toMatchObject({ always_on_top: true, opacity: 100 })
  expect(errors).toEqual([])
})

test('表示の設定を保存できなければ、前の値に戻してエラーを出す', async ({ page }) => {
  await boardWith(page, 1)
  const pin = page.getByRole('button', { name: '最前面に固定' })
  const opacity = page.getByRole('slider', { name: '不透明度' })
  await page.evaluate(() => sessionStorage.setItem('mock.failSettings', '1'))

  await pin.click()
  await expect(page.getByRole('alert')).toContainText('表示の設定を保存できません')
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await opacity.fill('60')
  await expect(opacity).toHaveValue('100')

  // 直れば、次の操作で保存できてエラーが消える
  await page.evaluate(() => sessionStorage.removeItem('mock.failSettings'))
  await opacity.fill('60')
  await expect.poll(() => display(page)).toMatchObject({ always_on_top: false, opacity: 60 })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('いちばん狭いウィンドウ（幅480）でも、上部の操作は折り返してすべて見えていて、そのまま押せる', async ({
  page,
}) => {
  await boardWith(page, 1)
  await page.setViewportSize({ width: 480, height: 320 })
  const toolbar = page.locator('.board__toolbar')
  // キャンバスは ResizeObserver で大きさを測り直してから配置を描く。その前に撮ると、前の大きさの位置に配置が写る
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: 'test-results/board-toolbar-narrow.png' })

  // 管理メニューの中の項目（閉じている間は見えない）は数えない。スクロールせずに、どれも画面の中にある
  for (const control of await toolbar.locator('> button, > select, input, [role=status]').all()) {
    const box = (await control.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(480)
    expect(box.y + box.height).toBeLessThanOrEqual(320)
  }
  expect(await toolbar.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
  await page.getByRole('slider', { name: '不透明度' }).fill('30')
  await page.getByRole('button', { name: '100%に戻す' }).click()
  await expect(page.getByRole('slider', { name: '不透明度' })).toHaveValue('100')

  // 初めの大きさ（幅1040。windows.rs の show_board_window）では1段に収まる
  await page.setViewportSize({ width: 1040, height: 640 })
  await expect(page.getByRole('status')).toBeInViewport()
  expect((await toolbar.boundingBox())!.height).toBeLessThan(48)
  await page.screenshot({ path: 'test-results/board-toolbar-default.png' })
})
