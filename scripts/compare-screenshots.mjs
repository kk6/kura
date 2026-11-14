// e2e のスクリーンショット（test-results/*.png）を、変更の前に撮った基準と比べる。
// リファクタリングで見た目が変わっていないことを確かめるのに使う。
//   node scripts/compare-screenshots.mjs save   今の test-results/ を基準として test-results-baseline/ に写す
//   node scripts/compare-screenshots.mjs        基準と1バイトでも違う画像、増えた画像、減った画像を出す
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'

const [current, baseline] = ['test-results', 'test-results-baseline']
const pngs = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.png'))
  } catch {
    return []
  }
}

const now = pngs(current)
if (!now.length) {
  console.error(`${current}/ に画像がありません。先に npm run test:e2e を流してください`)
  process.exit(1)
}

if (process.argv[2] === 'save') {
  rmSync(baseline, { recursive: true, force: true })
  mkdirSync(baseline)
  for (const f of now) cpSync(`${current}/${f}`, `${baseline}/${f}`)
  console.log(`基準にしました：${now.length}枚`)
} else {
  const base = pngs(baseline)
  if (!base.length) {
    console.error(`基準がありません。変更の前のコードで npm run test:e2e と npm run screenshots:save を流してください`)
    process.exit(1)
  }
  const problems = [
    ...base.filter((f) => !now.includes(f)).map((f) => `減った：${f}`),
    ...now.filter((f) => !base.includes(f)).map((f) => `増えた：${f}`),
    ...now
      .filter((f) => base.includes(f) && !readFileSync(`${current}/${f}`).equals(readFileSync(`${baseline}/${f}`)))
      .map((f) => `違う：${f}`),
  ]
  problems.forEach((p) => console.error(p))
  console.log(`${now.length}枚を比べました。食い違い ${problems.length}件`)
  process.exit(problems.length ? 1 : 0)
}
