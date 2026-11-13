/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// ドキュメントのスクリーンショット用に、モックの画面へ見本の写真を渡す（virtual:docs-photos）。
// KURA_DOCS_PHOTOS に「カテゴリ名のフォルダ／写真」の形のフォルダを渡したときだけ働く。
// 写真は縮小した写しを .claude/tmp/docs-photos/ に作って配る。元のフォルダには書かない。
// 写しの名前は元の写真の道筋から付ける。写真を足したり消したりしても、別の写真の写しを使わない
function docsPhotos(dir: string | undefined): Plugin {
  const id = 'virtual:docs-photos'
  const out = resolve('.claude/tmp/docs-photos')
  // 子のフォルダは子のカテゴリにする。category はルートからのフォルダ名の並び
  const walk = (path: string[]): { path: string[]; file: string }[] =>
    readdirSync(join(dir!, ...path), { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('_'))
      .flatMap((d) =>
        d.isDirectory()
          ? walk([...path, d.name])
          : /\.jpe?g$/i.test(d.name) && path.length
            ? [{ path, file: d.name }]
            : [],
      )
  const prepare = () => {
    mkdirSync(out, { recursive: true })
    const count = new Map<string, number>()
    const collator = new Intl.Collator('ja', { numeric: true })
    return walk([])
      .sort((a, b) => collator.compare(a.path.join('/'), b.path.join('/')) || collator.compare(a.file, b.file))
      .map(({ path, file }) => {
        const leaf = path.at(-1)!
        count.set(leaf, (count.get(leaf) ?? 0) + 1)
        const file_name = `${leaf}_${String(count.get(leaf)).padStart(2, '0')}.jpg`
        const copy = join(out, [...path, file].join('__'))
        if (!existsSync(copy))
          execFileSync('sips', ['-Z', '960', '-s', 'formatOptions', '80', join(dir!, ...path, file), '--out', copy])
        const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', copy], { encoding: 'utf8' })
        const [width, height] = ['pixelWidth', 'pixelHeight'].map((k) => Number(info.match(`${k}: (\\d+)`)![1]))
        return { file_name, category: path, width, height, url: `/@fs${copy}` }
      })
      .sort((a, b) => collator.compare(a.file_name, b.file_name))
  }
  let photos: ReturnType<typeof prepare> | null = null
  return {
    name: 'docs-photos',
    // 写しを作るのに数秒かかる。開発サーバーが応答する前に済ませ、最初の画面の読み込みを待たせない
    configureServer: () => void (photos = dir ? prepare() : null),
    resolveId: (s) => (s === id ? `\0${id}` : undefined),
    load: (s) => (s === `\0${id}` ? `export default ${JSON.stringify(photos ?? (dir ? prepare() : null))}` : undefined),
  }
}

export default defineConfig({
  plugins: [react(), docsPhotos(process.env.KURA_DOCS_PHOTOS)],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // e2e/ は Playwright、spikes/ は使い捨てなので含めない
  test: { include: ['src/**/*.test.ts'] },
})
