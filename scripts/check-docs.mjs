// ドキュメントがコードと食い違っていないかを機械的に調べる
// - docs/design.md のトークンの表と src/styles/tokens.css の名前と値
// - CLAUDE.md に書いた npm のコマンドが package.json にあるか
// - Tauri のコマンド名が、Rust、src/mocks/ipc.ts、画面の invoke で揃っているか
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path) => readFileSync(path, 'utf8')
const norm = (v) => v.replace(/\s+/g, ' ').trim().toLowerCase()
const problems = []

const css = new Map([...read('src/styles/tokens.css').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]))

// 表の先頭の列が変数名の行だけを読む。値は、バッククォートの列か、レイアウトの表の「高さ 48px」の数値
const doc = new Map()
for (const line of read('docs/design.md').split('\n')) {
  const m = line.match(/^\|\s*`(--[\w-]+)`\s*\|(.*)\|\s*$/)
  if (!m) continue
  const cells = m[2].split('|').map((c) => c.trim())
  const quoted = cells.find((c) => /^`.*`$/.test(c))
  doc.set(m[1], quoted ? quoted.slice(1, -1) : cells.at(-1).match(/\d+(?:\.\d+)?px/)?.[0])
}

for (const [name, value] of doc) {
  if (!css.has(name)) problems.push(`design.md の ${name} が tokens.css にない`)
  else if (norm(css.get(name)) !== norm(value ?? ''))
    problems.push(`${name}：design.md は ${value}、tokens.css は ${css.get(name)}`)
}
for (const name of css.keys()) {
  if (!doc.has(name)) problems.push(`tokens.css の ${name} が design.md の表にない`)
}

const scripts = JSON.parse(read('package.json')).scripts
for (const [, name] of read('CLAUDE.md').matchAll(/npm run ([\w:-]+)/g)) {
  if (!(name in scripts)) problems.push(`CLAUDE.md の npm run ${name} が package.json にない`)
}

// Tauri のコマンド名。モックの開発サーバーは Rust を通らないので、モックだけが古いままでも e2e は通ってしまう
const rust = new Set(
  read('src-tauri/src/main.rs')
    .match(/generate_handler!\[([^\]]*)\]/)[1]
    .match(/\w+/g),
)
const mock = new Set(
  [
    ...read('src/mocks/ipc.ts')
      .match(/^const handlers\b[^\n]*\n([\s\S]*?)^\}/m)[1]
      .matchAll(/^ {2}'?([\w:|]+)'?: /gm),
  ]
    .map((m) => m[1])
    .filter((n) => !n.includes(':')),
)
const invoked = new Set()
for (const path of readdirSync('src', { recursive: true })) {
  if (!/\.tsx?$/.test(path) || path.startsWith('mocks')) continue
  for (const [, name] of read(join('src', path)).matchAll(/invoke(?:<[^>]*>)?\(\s*'(\w+)'/g)) invoked.add(name)
}
for (const name of mock) if (!rust.has(name)) problems.push(`モックの ${name} が Rust のコマンドにない`)
for (const name of rust) if (!mock.has(name)) problems.push(`Rust のコマンド ${name} のモックがない`)
for (const name of invoked) if (!rust.has(name)) problems.push(`画面が呼ぶ ${name} が Rust のコマンドにない`)

if (problems.length) {
  console.error(`ドキュメントの食い違い（${problems.length}件）:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`ドキュメントの検査：トークン ${doc.size}件、npm のコマンド、Tauri のコマンド ${rust.size}件を確かめた`)
