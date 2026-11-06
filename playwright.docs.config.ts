// ドキュメントのスクリーンショットを撮る設定（npm run docs:screenshots）。CI では流さない
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: 'docs-screenshots.ts',
  outputDir: 'test-results/docs',
})
