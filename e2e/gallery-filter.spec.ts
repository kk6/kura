import { expect, test } from './fixtures'
import { openGallery, thumb, selectedNames } from './gallery-helpers'

test('サイドバーのカテゴリとタグを押し、検索バーに入れると絞り込み、件数は子カテゴリを含めて数える', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const categories = sidebar.getByRole('list', { name: 'カテゴリ' })
  const row = (name: string) =>
    categories.locator('.sidebar__item').filter({ has: page.getByRole('button', { name, exact: true }) })

  // ポーズ（id 1）は 300枚、子の座り・振り返りは 300枚ずつ。ポーズの件数は子を含めて 900枚
  await expect(row('ポーズ').locator('.sidebar__count')).toHaveText('900')
  await expect(row('座り').locator('.sidebar__count')).toHaveText('300')

  await categories.getByRole('button', { name: 'ポーズ', exact: true }).click()
  await expect(status).toContainText('900 / 2000枚')
  await expect(row('ポーズ')).toHaveClass(/sidebar__item--selected/)

  await sidebar.getByRole('button', { name: /^未分類/ }).click()
  await expect(status).toContainText('500 / 2000枚')

  await sidebar.getByRole('button', { name: /^すべての画像/ }).click()
  await expect(status).toContainText('2000枚')
  await expect(status).not.toContainText('/ 2000枚')

  // 2〜10枚目以外は、id が3の倍数に「あおり」、5の倍数に「座り」が付く
  const tags = sidebar.getByRole('list', { name: 'タグ' })
  await tags.getByRole('button', { name: /^あおり/ }).click()
  await tags.getByRole('button', { name: /^座り/ }).click({ modifiers: ['Meta'] })
  await expect(tags.getByRole('button', { name: /^あおり/ })).toHaveAttribute('aria-pressed', 'true')
  // AND は 15 の倍数と1枚目、OR は 3 か 5 の倍数と1枚目
  await expect(status).toContainText('134 / 2000枚')
  await sidebar.getByRole('button', { name: 'OR' }).click()
  await expect(status).toContainText('929 / 2000枚')
  await page.screenshot({ path: 'test-results/filter-tags.png' })

  await sidebar.getByRole('button', { name: 'AND' }).click()
  await tags.getByRole('button', { name: /^座り/ }).click()
  await page.keyboard.press('Escape')
  await expect(status).not.toContainText('/ 2000枚')

  // 検索はファイル名かメモに含む画像。大文字・小文字は区別しない
  const search = page.getByRole('combobox', { name: '検索' })
  await search.fill('REF_0001')
  await expect(status).toContainText('10 / 2000枚')
  await search.fill('肩の線')
  await expect(status).toContainText('1 / 2000枚')
  await search.fill('')
  expect(errors).toEqual([])
})

test('サイドバーのタグは押すたびに選ぶ・外すが切り替わり、Shift で範囲を選び、Escape・⌘A・余白はタグに効く', async ({
  page,
}) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const tags = sidebar.getByRole('list', { name: 'タグ' })
  // 1枚目には あおり と 座り が付いている。OR にして、タグを選んでも1枚目が見えたままにする
  await sidebar.getByRole('button', { name: 'OR' }).click()
  const tag = (name: string) => tags.getByRole('button', { name: new RegExp(`^${name}`) })
  const pressed = () =>
    tags
      .getByRole('button')
      .evaluateAll((bs) =>
        bs
          .filter((b) => b.getAttribute('aria-pressed') === 'true')
          .map((b) => b.querySelector('.sidebar__name')?.textContent),
      )

  // 並びは あおり、座り、振り返り。修飾キーなしで押すたびに選ぶ・外すが切り替わり、ほかのタグの選択は残す
  await tag('あおり').click()
  await tag('振り返り').click()
  expect(await pressed()).toEqual(['あおり', '振り返り'])
  // 選んでいるタグは先頭へ寄せ、残りは元の並びのまま
  await expect(tags.locator('.sidebar__name')).toHaveText(['あおり', '振り返り', '座り'])
  await tag('あおり').click()
  expect(await pressed()).toEqual(['振り返り'])
  // ⌘ を押しながら押しても同じ
  await tag('あおり').click({ modifiers: ['Meta'] })
  expect(await pressed()).toEqual(['あおり', '振り返り'])
  await tag('振り返り').click({ modifiers: ['Meta'] })
  expect(await pressed()).toEqual(['あおり'])
  // Shift は最後に修飾キーなしか ⌘ で押したタグ（あおり）から範囲を選び直す
  await tag('あおり').click()
  expect(await pressed()).toEqual([])
  await tag('振り返り').click({ modifiers: ['Shift'] })
  expect(await pressed()).toEqual(['あおり', '座り', '振り返り'])
  await tag('座り').click()
  await tag('あおり').click()
  await tag('振り返り').click()
  expect(await pressed()).toEqual([])

  // タグにフォーカスがあるときの Escape はタグの選択を外し、画像の選択は残す
  await thumb(page, 1).click()
  await tag('座り').click()
  await page.keyboard.press('Escape')
  expect(await pressed()).toEqual([])
  expect(await selectedNames(page)).toEqual(['ref_00001.jpg'])

  // ⌘A はタグをすべて選ぶ。一覧の画像は選ばない
  await tag('座り').click()
  await page.keyboard.press('Meta+a')
  expect(await pressed()).toEqual(['あおり', '座り', '振り返り'])
  expect(await selectedNames(page)).toEqual(['ref_00001.jpg'])

  // サイドバーの余白を押すとタグの選択を外す
  // 下端はライブラリの場所のボタンなので、その少し上を押す
  const box = (await sidebar.boundingBox())!
  const location = (await sidebar.getByRole('button', { name: /ライブラリの場所/ }).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, location.y - 10)
  expect(await pressed()).toEqual([])
})

test('見えなくなった画像の選択は絞り込みで外し、タグを外すと件数と絞り込みに反映する', async ({ page }) => {
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const detail = page.getByRole('complementary', { name: '詳細' })
  const aori = sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^あおり/ })

  await expect(aori.locator('.sidebar__count')).toHaveText('664')
  await aori.click()
  await expect(status).toContainText('664 / 2000枚')
  await thumb(page, 1).click()
  await detail.getByRole('button', { name: 'あおり を外す' }).click()
  await expect(aori.locator('.sidebar__count')).toHaveText('663')
  await expect(status).toContainText('663 / 2000枚')

  // 15枚目は制服にあるので、ポーズで絞ると見えなくなり、選択も外れる
  await thumb(page, 15).click()
  await expect(detail.getByRole('heading')).toHaveText('ref_00015.jpg')
  await sidebar.getByRole('list', { name: 'カテゴリ' }).getByRole('button', { name: 'ポーズ', exact: true }).click()
  await expect(detail).toContainText('画像を選ぶと、ここに詳細が出ます')
})

test('2万枚でも、タグ・カテゴリ・文字の絞り込みの結果が0.5秒以内に出る（NFR-02）', async ({ page }) => {
  await page.goto('/?images=20000')
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('20000枚')

  // 押してから、ステータスバーの枚数が変わった後の最初の描画までの時間を測る
  const measure = (act: string) =>
    page.evaluate(async (act) => {
      const bar = document.querySelector('footer')!
      const before = bar.textContent
      const start = performance.now()
      if (act.startsWith('search:')) {
        const input = document.querySelector<HTMLInputElement>('input[type=search]')!
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(input, act.slice(7))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        Array.from(document.querySelectorAll<HTMLButtonElement>('nav button'))
          .find((b) => b.textContent!.startsWith(act))!
          .click()
      }
      while (bar.textContent === before) await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => requestAnimationFrame(r))
      return performance.now() - start
    }, act)

  const times = {
    tag: await measure('あおり'),
    category: await measure('ポーズ'),
    text: await measure('search:ref_1'),
    clear: await measure('すべての画像'),
  }
  console.log('NFR-02 絞り込みの時間（ms）', times)
  for (const [name, ms] of Object.entries(times)) expect(ms, name).toBeLessThan(500)
})

test('タグ管理ダイアログで名前を変え、統合すると両方が付いていた画像も1つのタグになり、削除すると全部から外れる', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  await page.getByRole('combobox', { name: '並べ替え' }).selectOption({ label: 'ファイル名' })
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const sideTags = sidebar.getByRole('list', { name: 'タグ' })
  const detail = page.getByRole('complementary', { name: '詳細' })
  const status = page.getByRole('contentinfo')

  // 1枚目には「あおり」と「座り」が付いている。「座り」で絞っておく
  await thumb(page, 1).click()
  await expect(detail.locator('.tag')).toHaveText(['あおり', '座り'])
  await sideTags.getByRole('button', { name: /^座り/ }).click()
  await expect(status).toContainText('399 / 2000枚')

  await sidebar.getByRole('button', { name: 'タグを管理する' }).click()
  const dialog = page.getByRole('dialog', { name: 'タグを管理する' })
  const rows = dialog.getByRole('list', { name: 'タグ' }).locator('.tags__name')
  await expect(rows).toHaveText(['あおり', '座り', '振り返り'])
  await expect(dialog.getByRole('listitem').filter({ hasText: 'あおり' })).toContainText('664枚')

  // 名前の変更。ほかのタグと同じ名前はエラーにし、入力欄を残す
  await dialog.getByRole('button', { name: '「振り返り」の名前を変える' }).click()
  const input = dialog.getByRole('textbox', { name: '「振り返り」の新しい名前' })
  await input.fill('あおり')
  await input.press('Enter')
  await expect(dialog).toContainText('エラー：同じ名前のタグがあります（あおり）')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await page.screenshot({ path: 'test-results/tag-dialog-rename-error.png' })
  await input.fill('振り向き')
  await input.press('Enter')
  await expect(rows).toHaveText(['あおり', '座り', '振り向き'])
  // サイドバーでは、選んでいる「座り」が先頭に来る
  await expect(sideTags.locator('.sidebar__name')).toHaveText(['座り', 'あおり', '振り向き'])

  // 統合。「あおり」を「座り」にまとめる。1枚目は両方が付いているが「座り」1つになる
  await dialog.getByRole('button', { name: '「あおり」を統合する' }).click()
  await dialog.getByRole('combobox').selectOption({ label: '座り' })
  await expect(dialog).toContainText('「あおり」の 664枚に「座り」を付け、「あおり」を削除します')
  await page.screenshot({ path: 'test-results/tag-dialog-merge.png' })
  await dialog.getByRole('button', { name: '統合する', exact: true }).click()
  await expect(rows).toHaveText(['座り', '振り向き'])
  // 3 か 5 の倍数と1枚目
  await expect(dialog.getByRole('listitem').filter({ hasText: '座り' })).toContainText('929枚')

  // 削除。確かめてから全部の画像から外す
  await dialog.getByRole('button', { name: '「振り向き」を削除する' }).click()
  await expect(dialog).toContainText('「振り向き」を 284枚から外して削除します')
  await dialog.getByRole('button', { name: '削除する', exact: true }).click()
  await expect(rows).toHaveText(['座り'])

  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(dialog).toHaveCount(0)
  // 絞り込みの「座り」は残り、統合した分が増える。詳細パネルの1枚目のタグも読み直す
  await expect(sideTags.locator('.sidebar__name')).toHaveText(['座り'])
  await expect(status).toContainText('929 / 2000枚')
  await expect(detail.locator('.tag')).toHaveText(['座り'])
  expect(errors).toEqual([])
})

test('検索バーに入れると名前の合うカテゴリとタグを候補に出し、選ぶとそれで絞り込む', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const search = page.getByRole('combobox', { name: '検索' })
  const options = page.getByRole('listbox', { name: '絞り込みの候補' }).getByRole('option')
  const status = page.getByRole('contentinfo')
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })

  // 「座り」はカテゴリ（ポーズの下）とタグの両方にある
  await search.fill('座り')
  await expect(options).toHaveText(['カテゴリポーズ / 座り', 'タグ座り'])
  // 選ぶ前から、文字はタグ名とカテゴリ名にも探す。座りのカテゴリ 300枚と、座りのタグ 399枚（重ならない）
  await expect(status).toContainText('699 / 2000枚')
  await page.screenshot({ path: 'test-results/search-candidates.png' })

  // キーボードで選ぶ。入力した文字は消え、文字での絞り込みはやめる
  await search.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(search).toHaveValue('')
  await expect(status).toContainText('300 / 2000枚')
  await expect(
    sidebar.getByRole('list', { name: 'カテゴリ' }).getByRole('button', { name: '座り', exact: true }),
  ).toHaveAttribute('aria-current', 'true')

  // 押して選ぶ。いま使っているカテゴリは候補に出さない
  await search.fill('座り')
  await expect(options).toHaveText(['タグ座り'])
  await options.first().click()
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^座り/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 座りのカテゴリの画像（id を 5 で割って 2 余る）のうち、座りのタグ（5 の倍数）は付いていない
  await expect(status).toContainText('0 / 2000枚')
  // 絞り込みで0枚のときは、取り込み方ではなく条件に合わないことを出す
  await expect(page.getByRole('main', { name: '画像の一覧' })).toHaveText('条件に合う画像がありません')

  // Tab と Shift+Tab で候補を移り、最後の候補で Tab を押すと次の部品（並べ替え）へ移る
  // 座りのカテゴリとタグは絞り込みに使っているので出さない
  await search.fill('り')
  await expect(options).toHaveText(['カテゴリポーズ / 振り返り', 'タグあおり', 'タグ振り返り'])
  await search.press('Tab')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await search.press('Tab')
  await search.press('Shift+Tab')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(search).toBeFocused()
  for (let i = 0; i < 2; i++) await search.press('Tab')
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true')
  // 次の部品へ移る。どの部品かは macOS の「キーボードナビゲーション」の設定で変わる（オフだとボタンを飛ばす）ので、検索欄を離れたことだけを見る
  await search.press('Tab')
  await expect(search).not.toBeFocused()

  // 自動修正（cat を Cat にする提案）を出さない
  await expect(search).toHaveAttribute('autocorrect', 'off')
  await expect(search).toHaveAttribute('autocapitalize', 'off')

  // 合う候補がなければ出さず、Escape で文字を消す
  await search.fill('ref_0001')
  await expect(options).toHaveCount(0)
  await search.press('Escape')
  await expect(search).toHaveValue('')
  expect(errors).toEqual([])
})

test('サイドバーのタグ一覧を閉じても選んでいるタグは残し、閉じた状態は開き直しても残る', async ({ page }) => {
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const tags = sidebar.getByRole('list', { name: 'タグ' }).getByRole('button')
  const toggle = sidebar.getByRole('button', { name: 'タグ', exact: true })

  await tags.filter({ hasText: '座り' }).click()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(tags).toHaveText([/座り/])
  await page.screenshot({ path: 'test-results/tags-collapsed.png' })

  // 閉じた状態はアプリ全体の設定に残る
  await page.reload()
  await page.getByRole('button', { name: /Kura ライブラリ/ }).click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(tags).toHaveCount(0)
  await toggle.click()
  await expect(tags).toHaveCount(3)
})
