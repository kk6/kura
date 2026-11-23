import { expect, test, type Page } from './fixtures'
import { thumb } from './gallery-helpers'

// 骨格の重ね表示（FR-606）。モック（src/mocks/ipc.ts の imagePose）は、id を4で割って1余れば1人、3余れば2人の骨格を返し、
// 2余れば関節が足りない、割り切れれば人物なし。20枚のうち最後の3枚は未計算
const zoom = (page: Page) => page.getByRole('region', { name: '拡大表示' })
const toggle = (page: Page) => page.locator('.gallery__toolbar').getByRole('button', { name: '骨格を重ねる' })
const overlay = (page: Page) => zoom(page).locator('.zoom__pose')

async function open(page: Page, similarity: boolean) {
  await page.addInitScript((similarity) => {
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
  }, similarity)
  await page.goto('/?images=20')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
}

// 骨格の SVG が画像とぴったり重なっている
async function expectAligned(page: Page) {
  const [img, svg] = await Promise.all([zoom(page).getByRole('img').boundingBox(), overlay(page).boundingBox()])
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(img![k] - svg![k])).toBeLessThan(1)
}

const joints = async (page: Page) =>
  ((await overlay(page).locator('.zoom__pose-line.zoom__pose-joint').getAttribute('d')) ?? '').split('h0').length - 1

test('ポーズのある画像で「骨格を重ねる」を押すと、全員の骨格が画像に重なり、拡大して動かしても合う', async ({
  page,
}) => {
  await open(page, true)
  await thumb(page, 1).dblclick()
  // 初期値は OFF
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(overlay(page)).toHaveCount(0)
  await page.screenshot({ path: 'test-results/pose-off.png' })

  await toggle(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expectAligned(page)
  // 17点のうちスコアの低い左耳は描かない
  expect(await joints(page)).toBe(16)
  await page.screenshot({ path: 'test-results/pose-on.png' })

  // 拡大して動かしても、骨格は画像に重なったまま
  const plus = page.locator('.gallery__toolbar').getByRole('button', { name: '拡大' })
  await plus.click()
  await plus.click()
  await plus.click()
  const box = (await zoom(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 5 })
  await page.mouse.up()
  await expectAligned(page)
  await page.screenshot({ path: 'test-results/pose-zoomed.png' })

  // 次の画像（関節が足りない）では切り替えが出ず、2人の画像に移ると ON のまま全員分が出る
  await page.keyboard.press('ArrowRight')
  await expect(zoom(page).getByRole('img')).toHaveAccessibleName('ref_00002.jpg')
  await expect(toggle(page)).toHaveCount(0)
  await expect(overlay(page)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expectAligned(page)
  expect(await joints(page)).toBe(32)
  await page.screenshot({ path: 'test-results/pose-two.png' })

  // もう一度押すと消える
  await toggle(page).click()
  await expect(overlay(page)).toHaveCount(0)
})

test('人物がいない画像、手足が足りない画像、未計算の画像では「骨格を重ねる」を出さない', async ({ page }) => {
  await open(page, true)
  for (const n of [4, 2, 19]) {
    await thumb(page, n).dblclick()
    await expect(zoom(page).getByRole('img')).toBeVisible()
    await expect(page.locator('.gallery__toolbar').getByRole('slider', { name: '画像の倍率' })).toBeVisible()
    await expect(toggle(page)).toHaveCount(0)
    if (n === 4) await page.screenshot({ path: 'test-results/pose-none.png' })
    await page.keyboard.press('Escape')
  }
})

test('類似画像検索が OFF の間は、ポーズのある画像でも「骨格を重ねる」を出さない', async ({ page }) => {
  await open(page, false)
  await thumb(page, 1).dblclick()
  await expect(page.locator('.gallery__toolbar').getByRole('slider', { name: '画像の倍率' })).toBeVisible()
  await expect(toggle(page)).toHaveCount(0)
})
