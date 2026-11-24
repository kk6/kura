import { expect, test, type Page } from './fixtures'
import { thumbs, type TauriWindow } from './gallery-helpers'

// 「画像で探す」（FR-608）。モックの結果は、一覧の先頭の計算済みの画像（ref_00001）を基準にした値からその画像を除いたもの
// （src/mocks/ipc.ts の similarToFile）。20枚のうち最後の3枚は未計算
const COUNT = 20

async function open(page: Page, enabled = true) {
  await page.addInitScript((enabled) => {
    if (sessionStorage.getItem('mock.settings')) return
    sessionStorage.setItem(
      'mock.settings',
      JSON.stringify({
        confirm_category_move: true,
        thumb_width: 200,
        tags_collapsed: false,
        board_enabled: true,
        similarity_enabled: enabled,
        similarity_weights: {},
        board_window: { always_on_top: false, opacity: 100, frame: null },
      }),
    )
  }, enabled)
  await page.goto(`/?images=${COUNT}`)
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

const button = (page: Page) => page.getByRole('button', { name: /画像で探す|探しています/ })

// Tauri のドラッグのイベントを送る。macOS の本物と同じく、位置は CSS のピクセルのまま送る（e2e の devicePixelRatio は2）
async function drag(
  page: Page,
  event: 'enter' | 'over' | 'drop' | 'leave',
  at: { x: number; y: number },
  paths: string[] = [],
) {
  await page.evaluate(
    ([event, at, paths]) =>
      (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
        event: `tauri://drag-${event}`,
        payload: { paths, position: at },
      }),
    [event, at, paths] as const,
  )
}

async function center(page: Page) {
  const box = (await button(page).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('類似画像検索が OFF の間は「画像で探す」を出さない', async ({ page }) => {
  await open(page, false)
  await expect(page.getByRole('searchbox')).toBeVisible()
  await expect(button(page)).toHaveCount(0)
})

test('「画像で探す」に落とすと、落とした画像を基準にした結果を出し、取り込まない', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await open(page)
  await expect(button(page)).toBeVisible()
  await page.locator('.gallery__header').screenshot({ path: 'test-results/search-by-image.png' })

  // ドラッグしている間だけ落とし先として目立たせ、上に来たら押した状態の地にする
  const outside = { x: 600, y: 500 }
  await drag(page, 'enter', outside, ['/Users/me/Desktop/外.jpg'])
  await expect(button(page)).toHaveClass(/search-by-image--outside/)
  await page.screenshot({ path: 'test-results/search-by-image-drag.png' })
  await drag(page, 'over', await center(page))
  await expect(button(page)).toHaveClass(/search-by-image--over/)
  await page.locator('.gallery__header').screenshot({ path: 'test-results/search-by-image-over.png' })
  await drag(page, 'leave', outside)
  await expect(button(page)).not.toHaveClass(/search-by-image--/)

  await drag(page, 'enter', await center(page), ['/Users/me/Desktop/外.jpg'])
  await drag(page, 'drop', await center(page), ['/Users/me/Desktop/外.jpg'])
  const toolbar = page.locator('.gallery__toolbar')
  await expect(toolbar.getByRole('heading')).toHaveText('似た画像')
  await expect(toolbar.getByAltText('基準の画像 外.jpg')).toBeVisible()
  await expect(button(page)).not.toHaveClass(/search-by-image--/)
  // 基準はライブラリにないので、一覧には ref_00001 を含む計算済みの画像だけを並べる
  await expect(toolbar).toContainText('16枚')
  await expect(toolbar).toContainText('未計算 3枚')
  await expect(thumbs(page).and(page.getByAltText('ref_00001.jpg', { exact: true }))).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).not.toContainText('取り込み')
  await page.screenshot({ path: 'test-results/search-by-image-result.png' })

  // 結果の画像から「似た画像を探す」を押すと、基準が入れ替わる
  await thumbs(page)
    .and(page.getByAltText('ref_00005.jpg', { exact: true }))
    .click()
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: '似た画像を探す' }).click()
  await expect(toolbar.getByAltText('基準の画像 ref_00005.jpg')).toBeVisible()

  await toolbar.getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(toolbar.getByRole('heading')).toHaveText('すべての画像')
  expect(errors).toEqual([])
})

test('ほかの場所に落とすと、類似画像検索が ON でも今までどおり取り込む', async ({ page }) => {
  await open(page)
  await drag(page, 'enter', { x: 600, y: 500 }, ['/Users/me/Downloads/a.jpg'])
  await drag(page, 'drop', { x: 600, y: 500 }, ['/Users/me/Downloads/a.jpg'])
  await expect(page.getByRole('contentinfo')).toContainText('完了：取り込み')
  await expect(page.locator('.gallery__toolbar').getByRole('heading')).toHaveText('すべての画像')
})

test('1枚の画像でないものを落とすと、探さずに理由を出す', async ({ page }) => {
  await open(page)
  const status = page.getByRole('contentinfo')
  for (const [paths, reason] of [
    [['/Users/me/Desktop/a.jpg', '/Users/me/Desktop/b.jpg'], '画像で探せるのは1枚だけです'],
    [['/Users/me/Desktop/資料'], 'フォルダでは探せません'],
    [['/Users/me/Desktop/a.txt'], '対応していない形式のファイルでは探せません'],
  ] as const) {
    await drag(page, 'drop', await center(page), [...paths])
    await expect(status).toContainText(reason)
  }
  await expect(page.locator('.gallery__toolbar').getByRole('heading')).toHaveText('すべての画像')
})

test('押すとファイル選択を開き、選んだ画像で探す', async ({ page }) => {
  await open(page)
  await page.evaluate(() => sessionStorage.setItem('mock.openPath', '/Users/me/Pictures/選んだ.png'))
  await button(page).click()
  await expect(page.locator('.gallery__toolbar').getByAltText('基準の画像 選んだ.png')).toBeVisible()
})
