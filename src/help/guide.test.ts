import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderGuide, slug } from './guide'

// ヘルプ（NFR-14）は docs/user-guide.md をそのまま HTML にする。本物のガイドで、目次のリンクと画像が欠けないことを確かめる
const guide = readFileSync('docs/user-guide.md', 'utf8')
const images = Object.fromEntries(readdirSync('docs/images').map((f) => [`../../docs/images/${f}`, `/assets/${f}`]))

describe('slug', () => {
  it('GitHub と同じく、記号を落とし、空白をハイフンにし、英字を小文字にする', () => {
    expect(slug('ライブラリを作る・開く')).toBe('ライブラリを作る開く')
    expect(slug('Finder で変えたとき（差分の確認）')).toBe('finder-で変えたとき差分の確認')
    expect(slug('ファイル名、メモ、評価')).toBe('ファイル名メモ評価')
  })
})

describe('renderGuide', () => {
  const html = renderGuide(guide, images)

  it('ガイドのどの見出しも出し、ガイドの中のリンクはどれも見出しに届く', () => {
    const headings = guide.match(/^#{1,6} .+$/gm)!
    expect(html.match(/<h[1-6] id="/g)).toHaveLength(headings.length)
    const ids = new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]))
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))
    expect(anchors.length).toBeGreaterThan(10)
    expect(anchors.filter((a) => !ids.has(a))).toEqual([])
  })

  it('画像は、ビルドでアプリに入れた画像を指す', () => {
    const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
    expect(srcs).toHaveLength(guide.match(/!\[[^\]]*\]\(images\//g)!.length)
    expect(srcs.filter((s) => !s.startsWith('/assets/'))).toEqual([])
  })

  it('同じ見出しが2つあれば、2つ目に -1 を付ける', () => {
    expect(renderGuide('## 例\n\n## 例\n', {})).toBe('<h2 id="例">例</h2>\n<h2 id="例-1">例</h2>\n')
  })
})
