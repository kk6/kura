// ドキュメントのスクリーンショットを撮る設定（npm run docs:screenshots）。CI では流さない
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

if (!process.env.KURA_DOCS_PHOTOS)
  throw new Error('KURA_DOCS_PHOTOS に見本の写真のフォルダを渡す（README の「スクリーンショット」）')

export default defineConfig({
  ...base,
  // 写真を渡していない開発サーバーを使い回さない
  webServer: { command: 'npm run dev:mock', url: 'http://localhost:5173', reuseExistingServer: false },
  testMatch: 'docs-screenshots.ts',
  outputDir: 'test-results/docs',
})
