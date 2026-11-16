import { rankSimilar } from '../src/similarity'
import { expect, test, type Page } from './fixtures'
import { thumbs } from './gallery-helpers'

// モックは20枚にする。最後の3枚（18〜20）は未計算。類似度は id から決まる（src/mocks/ipc.ts の similarImages）
const COUNT = 20
const UNCOMPUTED = [18, 19, 20]
const name = (id: number) => `ref_${String(id).padStart(5, '0')}.jpg`

async function open(page: Page, enabled = true) {
  if (enabled)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('mock.settings')) return
      sessionStorage.setItem(
        'mock.settings',
        JSON.stringify({
          confirm_category_move: true,
          thumb_width: 200,
          tags_collapsed: false,
          board_enabled: true,
          similarity_enabled: true,
          similarity_weights: {},
          board_window: { always_on_top: false, opacity: 100, frame: null },
        }),
      )
    })
  await page.goto(`/?images=${COUNT}`)
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(page.getByRole('contentinfo')).toContainText('差分を反映')
}

const pick = (page: Page, id: number) =>
  thumbs(page)
    .and(page.getByAltText(name(id), { exact: true }))
    .click()
const listed = (page: Page) =>
  thumbs(page).evaluateAll((imgs) =>
    imgs
      .map((i) => ({ alt: i.getAttribute('alt')!, y: (i as HTMLElement).style.transform }))
      .map((i) => ({ ...i, xy: i.y.match(/-?[\d.]+/g)!.map(Number) }))
      .sort((a, b) => a.xy[1] - b.xy[1] || a.xy[0] - b.xy[0])
      .map((i) => Number(i.alt.match(/\d+/)![0])),
  )
const findButton = (page: Page) =>
  page.getByRole('complementary', { name: '詳細' }).getByRole('button', { name: '似た画像を探す' })
const toolbar = (page: Page) => page.locator('.gallery__toolbar')
const slider = (page: Page, label: string) => page.getByRole('group', { name: '観点ごとの重み' }).getByLabel(label)

// モックの similarImages と同じ値で、重みを掛けた並びを出す
function expected(base: number, weights: Record<string, number>, keep: (id: number) => boolean = () => true) {
  const ids = Array.from({ length: COUNT - UNCOMPUTED.length }, (_, i) => i + 1)
  const score = (id: number, k: number) => (id === base ? 3 : Math.sin(id * k + base))
  return rankSimilar(
    {
      base,
      aspects: ['content', 'composition'],
      ids,
      scores: [ids.map((i) => score(i, 0.7)), ids.map((i) => score(i, 1.3))],
      uncomputed: UNCOMPUTED.length,
    },
    weights,
  ).filter(keep)
}

// 一覧の上から順に、列をまたいで並ぶ。左上から読んだ順と、並びの先頭からの順は、上端の近い所で前後する。
// そのため先頭（基準画像）と、並びに含まれる画像の集合で確かめ、順は重みの単体テスト（Vitest）で確かめる
async function expectResults(page: Page, ids: number[]) {
  await expect
    .poll(() => listed(page).then((l) => [...l].sort((a, b) => a - b)))
    .toEqual([...ids].sort((a, b) => a - b))
  expect((await listed(page))[0]).toBe(ids[0])
}

test('OFF の間は、詳細パネルにも右クリックメニューにも「似た画像を探す」が出ない', async ({ page }) => {
  await open(page, false)
  await pick(page, 1)
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText('Finderで表示')
  await expect(findButton(page)).toHaveCount(0)
  await thumbs(page)
    .and(page.getByAltText(name(1), { exact: true }))
    .click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'ボードに追加…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '似た画像を探す' })).toHaveCount(0)
})

test('未計算の画像では押せず理由が出る。複数を選ぶと詳細パネルにも右クリックメニューにも押せる入口がない', async ({
  page,
}) => {
  await open(page)
  await pick(page, 19)
  await expect(findButton(page)).toBeDisabled()
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText('特徴量を計算するまで探せません')
  await page.locator('#detail-similar-note').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/similarity-uncomputed.png' })
  await thumbs(page)
    .and(page.getByAltText(name(19), { exact: true }))
    .click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: '似た画像を探す' })
  await expect(item).toBeDisabled()
  await expect(item).toHaveAttribute('title', '特徴量を計算するまで探せません')
  await page.keyboard.press('Escape')

  await pick(page, 1)
  await expect(findButton(page)).toBeEnabled()
  await thumbs(page)
    .and(page.getByAltText(name(2), { exact: true }))
    .click({ modifiers: ['Meta'] })
  await expect(findButton(page)).toHaveCount(0)
  await thumbs(page)
    .and(page.getByAltText(name(2), { exact: true }))
    .click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '似た画像を探す' })).toBeDisabled()
})

test('押すと結果のモードになり、基準画像が先頭で、未計算は出さずに枚数を知らせ、閉じると元の並びとスクロールに戻る', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 })
  await open(page)
  const before = await listed(page)
  const list = page.getByRole('main', { name: '画像の一覧' })
  // 押した画像が見える所まで一覧が動かないよう、選んでからスクロールする
  await pick(page, 5)
  await list.evaluate((el) => (el.scrollTop = 200))
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(200)
  await findButton(page).click()

  await expect(toolbar(page).getByRole('heading')).toHaveText('似た画像')
  await expect(toolbar(page)).toContainText('17枚')
  await expect(toolbar(page)).toContainText('未計算 3枚')
  await expect(toolbar(page).getByAltText(`基準の画像 ${name(5)}`)).toBeVisible()
  await expect(page.getByRole('combobox', { name: '並べ替え' })).toHaveCount(0)
  await expect(slider(page, '写っているもの')).toHaveValue('50')
  await expect(slider(page, '明暗と線の配置')).toHaveValue('50')
  // ラベルだけでは何を比べるか分からなかったので、下の2行目に短い説明を出す（タスク11で見つけた）
  await expect(slider(page, '写っているもの')).toHaveAccessibleDescription('人や物、場面')
  await expect(slider(page, '明暗と線の配置')).toHaveAccessibleDescription('明るい所と暗い所、線の向き')
  await expect(page.getByRole('contentinfo')).toContainText('17枚')
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expectResults(page, expected(5, { content: 50, composition: 50 }))
  for (const id of UNCOMPUTED) await expect(page.getByAltText(name(id), { exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/similarity-results.png' })
  await page.setViewportSize({ width: 1440, height: 500 })

  await toolbar(page).getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(toolbar(page).getByRole('heading')).toHaveText('すべての画像')
  await expect(page.getByRole('combobox', { name: '並べ替え' })).toBeVisible()
  await expect(page.getByRole('group', { name: '観点ごとの重み' })).toHaveCount(0)
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(200)
  await list.evaluate((el) => (el.scrollTop = 0))
  await expect.poll(() => listed(page)).toEqual(before)
})

test('Escape は拡大表示、選択の順に外し、何もなければ結果のモードを閉じる。右クリックから押せ、結果の画像から押すと基準が替わる', async ({
  page,
}) => {
  await open(page)
  await thumbs(page)
    .and(page.getByAltText(name(3), { exact: true }))
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '似た画像を探す' }).click()
  await expect(toolbar(page).getByAltText(`基準の画像 ${name(3)}`)).toBeVisible()

  // 拡大表示の左右は結果の並び順
  const order = expected(3, { content: 50, composition: 50 })
  await pick(page, order[0])
  await page.keyboard.press(' ')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('complementary', { name: '詳細' })).toContainText(name(order[1]))
  await page.keyboard.press('Escape')
  await expect(toolbar(page).getByRole('heading')).toHaveText('似た画像')

  await findButton(page).click()
  await expect(toolbar(page).getByAltText(`基準の画像 ${name(order[1])}`)).toBeVisible()
  await expectResults(page, expected(order[1], { content: 50, composition: 50 }))

  await page.keyboard.press('Escape')
  await expect(page.locator('.list__thumb--selected')).toHaveCount(0)
  await expect(toolbar(page).getByRole('heading')).toHaveText('似た画像')
  await page.keyboard.press('Escape')
  await expect(toolbar(page).getByRole('heading')).toHaveText('すべての画像')
})

test('重みで並びが変わり、両方は0にできず、手を離すと保存して次の検索でも使う', async ({ page }) => {
  await open(page)
  await pick(page, 7)
  await findButton(page).click()

  await slider(page, '明暗と線の配置').focus()
  await page.keyboard.press('Home')
  await expect(slider(page, '明暗と線の配置')).toHaveValue('0')
  await expectResults(page, expected(7, { content: 50, composition: 0 }))

  await slider(page, '写っているもの').focus()
  await page.keyboard.press('Home')
  await expect(slider(page, '写っているもの')).toHaveValue('1')
  await page.keyboard.press('End')
  await expect(slider(page, '写っているもの')).toHaveValue('100')
  await page.getByRole('group', { name: '観点ごとの重み' }).screenshot({ path: 'test-results/similarity-weights.png' })

  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('mock.settings')!).similarity_weights))
    .toEqual({ content: 100, composition: 0 })

  await toolbar(page).getByRole('button', { name: '閉じる', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await pick(page, 2)
  await findButton(page).click()
  await expect(slider(page, '写っているもの')).toHaveValue('100')
  await expect(slider(page, '明暗と線の配置')).toHaveValue('0')
})

test('結果をカテゴリ・タグ・検索バーで絞り込め、件数は結果の枚数で数え、閉じても絞り込みは残る', async ({ page }) => {
  await open(page)
  await pick(page, 1)
  await findButton(page).click()

  // 「あおり」は id が3の倍数の画像（11枚目から）と1枚目に付いている
  await page
    .getByRole('navigation', { name: 'サイドバー' })
    .getByRole('button', { name: /^あおり/ })
    .click()
  const tagged = (id: number) => id === 1 || (id >= 11 && id % 3 === 0)
  await expectResults(page, expected(1, { content: 50, composition: 50 }, tagged))
  await expect(page.getByRole('contentinfo')).toContainText('3 / 17枚')

  await page.getByRole('combobox', { name: '検索' }).fill('ref_0001')
  // ref_00010〜ref_00019 のうち、あおりが付いていて計算済みなのは 12 と 15
  await expectResults(
    page,
    expected(1, { content: 50, composition: 50 }, (id) => [12, 15].includes(id)),
  )
  await page.getByRole('combobox', { name: '検索' }).fill('')

  await toolbar(page).getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(page.getByRole('contentinfo')).toContainText(`4 / ${COUNT}枚`)
})
