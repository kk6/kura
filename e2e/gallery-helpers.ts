import type { TauriWindow } from './board-helpers'
import { expect } from './fixtures'

// ギャラリーの e2e で使う操作

export type { TauriWindow }

export async function openGallery(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('banner')).toBeVisible()
  // 開いた後の差分検出（FR-104）が終わるまで待つ。その間は取り込みを受け付けず、結果がステータスバーを上書きするため
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

// メニューの「ライブラリを切り替える…」（FR-105）。Rust はメニューを選ぶと switch-library を送るだけなので、その送信を真似る
export const switchLibrary = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'switch-library',
      payload: null,
    }),
  )

export const thumbs = (page: import('@playwright/test').Page) =>
  page.getByRole('main', { name: '画像の一覧' }).getByRole('img')

// 描いているサムネイルの列の数（transform の x の種類の数）
export const columnCount = (page: import('@playwright/test').Page) =>
  thumbs(page).evaluateAll((imgs) => new Set(imgs.map((i) => (i as HTMLElement).style.transform.split(',')[0])).size)

export const thumb = (page: import('@playwright/test').Page, n: number) =>
  thumbs(page).and(page.getByAltText(`ref_${String(n).padStart(5, '0')}.jpg`, { exact: true }))

export const selectedNames = (page: import('@playwright/test').Page) =>
  page.locator('.list__thumb--selected').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('alt')).sort())
