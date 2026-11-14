import { test as base } from '@playwright/test'

export * from '@playwright/test'

// スクリーンショットは動きを止めて撮る。回るスピナーの角度や、背景色が変わる途中の色が写ると、
// 同じ画面でも撮るたびに違う画像になり、変更の前後で比べられない（scripts/compare-screenshots.mjs）。
// prefers-reduced-motion にはしない。画面の動きそのもの（詳細パネルの開閉など）のテストが変わるため
export const test = base.extend({
  page: async ({ page }, run) => {
    const shoot = page.screenshot.bind(page)
    page.screenshot = (options) => shoot({ animations: 'disabled', ...options })
    await run(page)
  },
})
