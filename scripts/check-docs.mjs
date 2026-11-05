// ドキュメントがコードと食い違っていないかを機械的に調べる
// - docs/design.md のトークンの表と src/styles/tokens.css の名前と値
// - CLAUDE.md に書いた npm のコマンドが package.json にあるか
import { readFileSync } from 'node:fs'

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

if (problems.length) {
  console.error(`ドキュメントの食い違い（${problems.length}件）:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`ドキュメントの検査：トークン ${doc.size}件、npm のコマンドを確かめた`)
