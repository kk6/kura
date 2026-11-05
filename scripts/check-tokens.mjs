// 画面のコードが tokens.css の変数だけを使っているかを調べる（CLAUDE.md「画面の決まり」）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = 'src/styles/tokens.css'
const RAW_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d*\.?\d+(?:px|rem|em)\b/gi

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (/\.(css|tsx?)$/.test(entry.name) && path !== TOKENS) yield path
  }
}

const problems = []
for (const path of files('src')) {
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [value] of line.matchAll(RAW_VALUE)) problems.push(`${path}:${i + 1}: ${value}`)
    })
}

if (problems.length) {
  console.error(`tokens.css の変数を使わずに値を書いている箇所があります:\n${problems.join('\n')}`)
  process.exit(1)
}
