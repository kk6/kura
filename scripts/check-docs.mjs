// ドキュメントがコードと食い違っていないかを機械的に調べる
// - docs/design.md のトークンの表と src/styles/tokens.css の名前と値
// - CLAUDE.md と README.md に書いた npm のコマンドが package.json にあるか
// - Tauri のコマンド名が、Rust、src/mocks/ipc.ts、画面の invoke で揃っているか
// - アプリのバージョンが package.json、Cargo.toml、tauri.conf.json とロックファイルで揃っているか
// - 利用者向けの文書に書いたモデルの大きさ（約 N MB）が ml/model.json と合っているか
// - 終わったフェーズ（要件定義書の9章の「（完了：<版>）」）の記述が、途中のまま残っていないか
// - 検証のスキル（.claude/skills/verify-*）が CLAUDE.md と開発ガイドに載っているか
// - docs/ の文書が、ほかの文書からリンクされているか
// - ヘルプ（NFR-14）に入れる docs/user-guide.md の画像が docs/images/ にあるか。見出しへのリンクは src/help/guide.test.ts が見る
import { execFileSync } from 'node:child_process'
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
for (const file of ['CLAUDE.md', 'README.md']) {
  for (const [, name] of read(file).matchAll(/npm run ([\w:-]+)/g)) {
    if (!(name in scripts)) problems.push(`${file} の npm run ${name} が package.json にない`)
  }
}

// Tauri のコマンド名。モックの開発サーバーは Rust を通らないので、モックだけが古いままでも e2e は通ってしまう
const rust = new Set(
  read('src-tauri/src/main.rs')
    .match(/generate_handler!\[([^\]]*)\]/)[1]
    // windows::show_board_window のようにモジュールの下にあるコマンドは、最後の名前だけを取る
    .match(/\w+(?=\s*(,|$))/g),
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

// バージョンは npm run version:set でそろえる（scripts/set_version.py）
const lock = JSON.parse(read('package-lock.json'))
const versions = {
  'package.json': JSON.parse(read('package.json')).version,
  'package-lock.json': lock.version,
  'package-lock.json の packages[""]': lock.packages[''].version,
  'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'src-tauri/Cargo.toml': read('src-tauri/Cargo.toml').match(/^\[package\]\nname = "kura"\nversion = "([^"]+)"/m)?.[1],
  'src-tauri/Cargo.lock': read('src-tauri/Cargo.lock').match(/^name = "kura"\nversion = "([^"]+)"/m)?.[1],
}
if (new Set(Object.values(versions)).size !== 1)
  problems.push(
    `バージョンが食い違っている（npm run version:set でそろえる）：${Object.entries(versions)
      .map(([f, v]) => `${f} は ${v}`)
      .join('、')}`,
  )

// モデルの大きさ。画面は model_size で数えるので、手で書いた文書だけがモデルの差し替えで古くなる。
// ダウンロードする大きさ（archive があれば zip の大きさ）を MB に丸めて比べる。
// 「ポーズのモデル」と書いた所はポーズの観点の大きさ、ほかの「モデル」は全体の大きさ
const aspects = JSON.parse(read('ml/model.json')).aspects
const mb = (files) => Math.round(files.reduce((s, f) => s + (f.archive?.size ?? f.size), 0) / 1e6)
const total = mb(aspects.flatMap((a) => a.files))
const pose = mb(aspects.filter((a) => a.kind === 'pose').flatMap((a) => a.files))
for (const file of ['README.md', 'docs/user-guide.md', 'homepage/index.html']) {
  for (const m of read(file).matchAll(/(ポーズの)?モデル[^。\n]{0,20}?約\s?(\d+)\s?MB/g)) {
    const want = m[1] ? pose : total
    if (Number(m[2]) !== want) problems.push(`${file} の「${m[0]}」が ml/model.json と合わない（${want} MB）`)
  }
}

// フェーズを閉じたあとに残りやすい古い記述。フェーズを閉じるときに人が手で見直すのは漏れる
const requirements = read('docs/requirements.md')
const phases = [...requirements.matchAll(/^\d+\. \*\*フェーズ(\d+)：[^*]+\*\*(（完了：[\d.]+）)?$/gm)]
const done = new Set(phases.filter((m) => m[2]).map((m) => m[1]))
const open = phases.filter((m) => !m[2]).map((m) => m[1])
for (const name of readdirSync('docs/tasks')) {
  const n = name.match(/^phase(\d+)/)?.[1]
  if (!done.has(n)) continue
  for (const word of ['確認待ち', '未着手', 'すべて未確認', 'に使う依頼案']) {
    if (read(`docs/tasks/${name}`).includes(word))
      problems.push(`フェーズ${n}は完了したのに、docs/tasks/${name} に「${word}」が残っている`)
  }
}
const notYet = read('README.md').match(/^## まだできないこと\n([\s\S]*?)^## /m)?.[1] ?? ''
const listed = [...notYet.matchAll(/^- フェーズ(\d+)：/gm)].map((m) => m[1])
if (listed.join() !== open.join())
  problems.push(
    `README の「まだできないこと」のフェーズ（${listed.join('、') || 'なし'}）が、要件定義書の完了していないフェーズ（${open.join('、')}）と合わない`,
  )

// 過ぎた版や終わったフェーズを期限にした記述
const semver = (v) => v.split('.').reduce((n, x) => n * 1000 + Number(x), 0)
const current = semver(versions['package.json'])
for (const file of ['README.md', 'docs/requirements.md', 'docs/development.md']) {
  for (const [text, v] of read(file).matchAll(/(\d+\.\d+\.\d+) の次の版/g)) {
    if (semver(v) < current) problems.push(`${file} の「${text}」は、もう ${versions['package.json']} が出ている`)
  }
}
const pending = requirements.match(/^## 10\. 未決事項\n([\s\S]*)/m)[1]
for (const [line, n] of pending.matchAll(/^- \[ \] .*（[^）]*フェーズ(\d+)[^）]*）.*$/gm)) {
  if (done.has(n)) problems.push(`未決事項の「${line.slice(6, 46)}…」の時期が、終わったフェーズ${n}になっている`)
}

// 検証のスキルは、CLAUDE.md の「検証のスキル」と開発ガイドの両方から使い方を知る
for (const name of readdirSync('.claude/skills').filter((n) => n.startsWith('verify-'))) {
  for (const file of ['CLAUDE.md', 'docs/development.md']) {
    if (!read(file).includes(name)) problems.push(`検証のスキル ${name} が ${file} に載っていない`)
  }
}

// どこからもリンクされない文書は、役目を終えても気づかれずに残る。README.md はフォルダの名前で探す
const markdown = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const texts = new Map(markdown.map((f) => [f, read(f)]))
for (const file of markdown.filter((f) => f.startsWith('docs/'))) {
  const parts = file.split('/')
  const key = parts.at(-1) === 'README.md' ? `${parts.at(-2)}/` : parts.at(-1)
  if (![...texts].some(([other, text]) => other !== file && text.includes(key)))
    problems.push(`${file} がどの文書からもリンクされていない（役目を終えたなら消す）`)
}

// ヘルプはビルドのときに docs/images/ の画像を入れる。ない画像はヘルプで欠ける
const bundled = new Set(readdirSync('docs/images'))
for (const [, name] of read('docs/user-guide.md').matchAll(/\]\(images\/([^)]+)\)/g)) {
  if (!bundled.has(name)) problems.push(`docs/user-guide.md の images/${name} が docs/images/ にない（ヘルプで欠ける）`)
}

if (problems.length) {
  console.error(`ドキュメントの食い違い（${problems.length}件）:\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(
  `ドキュメントの検査：トークン ${doc.size}件、npm のコマンド、Tauri のコマンド ${rust.size}件、モデルの大きさ、バージョン ${versions['package.json']}、完了したフェーズ ${[...done].join('・')} の記述、検証のスキル、文書のリンク、ヘルプの画像を確かめた`,
)
