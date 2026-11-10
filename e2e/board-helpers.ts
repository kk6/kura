import { expect, type Locator, type Page } from '@playwright/test'

// ボードのキャンバスの e2e で使う操作

export type TauriWindow = { __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> } }
export type Geometry = { x: number; y: number; width: number; height: number; scale: number; stack_order: number }
export type Stored = {
  viewport?: { x: number; y: number; scale: number }
  items: { id: number; source: { image_id: number }; geometry: Geometry }[]
}
type Point = { x: number; y: number }

export const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.boards')!).boards[0] as Stored)

export const emit = (page: Page, event: string, payload: unknown = null) =>
  page.evaluate(
    ([event, payload]) =>
      (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload }),
    [event, payload] as const,
  )

// ギャラリーの先頭から count 枚を新しいボードに追加し、ボードの画面を開いて選択を外す
export async function boardWith(page: Page, count: number) {
  await page.goto('/')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
  const thumbs = page.locator('.list__thumb')
  await thumbs.nth(0).click()
  for (let i = 1; i < count; i++) await thumbs.nth(i).click({ modifiers: ['Meta'] })
  await page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: 'ボードに追加' }).click()
  await page.getByRole('dialog', { name: 'ボードに追加' }).getByRole('button', { name: '追加' }).click()
  await page.goto('/?board')
  const canvas = page.getByRole('main', { name: /キャンバス/ })
  const items = canvas.getByRole('img')
  await expect(items).toHaveCount(count)
  // 追加の後の全体表示が保存されてから始める。途中で保存が重なると、保存された値を比べにくい
  await expect.poll(async () => (await stored(page)).viewport).toBeTruthy()
  await expect(page.getByRole('status')).toHaveText('保存済み')
  const area = (await canvas.boundingBox())!
  const blank = { x: area.x + 10, y: area.y + 10 }
  await page.mouse.click(blank.x, blank.y)
  await expect(canvas.locator('.board__item--selected')).toHaveCount(0)
  return { canvas, items, area, blank }
}

export const box = async (item: Locator) => (await item.boundingBox())!
export const center = (b: { x: number; y: number; width: number; height: number }): Point => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
})

export async function drag(page: Page, from: Point, to: Point, button: 'left' | 'middle' = 'left') {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button })
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up({ button })
}

export const selectedIds = (canvas: Locator) =>
  canvas.locator('.board__item--selected').evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.id)))
