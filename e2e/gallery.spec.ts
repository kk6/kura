import { expect, test } from '@playwright/test'

type TauriWindow = { __TAURI_INTERNALS__: { invoke(cmd: string): Promise<unknown> } }

test('ギャラリー画面の枠が表示される', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')

  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'サイドバー' })).toBeVisible()
  await expect(page.getByRole('main', { name: '画像の一覧' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '詳細' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  expect(errors).toEqual([])

  await page.screenshot({ path: 'test-results/gallery.png' })
})

test('Tauri のコマンドがモックに差し替わっている', async ({ page }) => {
  await page.goto('/')
  const message = await page.evaluate(() => {
    const tauri = (window as unknown as TauriWindow).__TAURI_INTERNALS__
    return tauri.invoke('no_such_command').catch((e: unknown) => String(e))
  })
  expect(message).toContain('モックが未定義のコマンド: no_such_command')
})
