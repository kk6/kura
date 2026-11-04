/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // e2e/ は Playwright、spikes/ は使い捨てなので含めない
  test: { include: ['src/**/*.test.ts'] },
})
