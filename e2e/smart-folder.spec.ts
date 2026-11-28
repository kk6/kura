import { expect, test } from './fixtures'
import { openGallery } from './gallery-helpers'

test('今の絞り込みと並べ替えをスマートフォルダに保存し、開き直しても押すと同じ絞り込みになり、名前の変更と削除ができる', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  const status = page.getByRole('contentinfo')
  const sort = page.getByRole('combobox', { name: '並べ替え' })
  const save = page.getByRole('button', { name: 'スマートフォルダとして保存…' })
  const title = page.locator('.toolbar__title')

  // 絞り込みも並べ替えも初期のままなら、保存するものがないので出さない。1つもない間は見出しも出さない
  await expect(save).toBeHidden()
  await expect(sidebar.getByRole('heading', { name: 'スマートフォルダ' })).toBeHidden()

  await sidebar.getByRole('list', { name: 'カテゴリ' }).getByRole('button', { name: 'ポーズ', exact: true }).click()
  await sidebar
    .getByRole('list', { name: 'タグ' })
    .getByRole('button', { name: /^あおり/ })
    .click()
  await sort.selectOption({ label: 'ファイル名' })
  await expect(status).toContainText('/ 2000枚')
  const count = (await status.locator('span').first().textContent())!

  await save.click()
  const dialog = page.getByRole('dialog', { name: 'スマートフォルダとして保存' })
  await dialog.getByLabel('名前').fill('ポーズのあおり')
  await page.screenshot({ path: 'test-results/smart-folder-save.png' })
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()

  const folders = sidebar.getByRole('list', { name: 'スマートフォルダ' })
  const folder = (name: string) => folders.getByRole('button', { name })
  await expect(folder('ポーズのあおり')).toHaveAttribute('aria-current', 'true')
  await expect(title).toHaveText('ポーズのあおり')
  await page.screenshot({ path: 'test-results/smart-folder-sidebar.png' })

  // 絞り込みを変えると、開いている見た目を外す
  await sidebar.getByRole('button', { name: /^すべての画像/ }).click()
  await expect(folder('ポーズのあおり')).toHaveAttribute('aria-current', 'false')
  await expect(title).toHaveText('すべての画像')

  // 開き直すと絞り込みは初期に戻り、スマートフォルダは残る
  await openGallery(page)
  await expect(status).not.toContainText('/ 2000枚')
  await expect(sort).toHaveValue('imported')
  await folder('ポーズのあおり').click()
  await expect(status.locator('span').first()).toHaveText(count)
  await expect(sort).toHaveValue('name')
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^あおり/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(title).toHaveText('ポーズのあおり')
  await page.screenshot({ path: 'test-results/smart-folder-opened.png' })

  await folder('ポーズのあおり').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '名前を変更…' }).click()
  const input = sidebar.getByRole('textbox', { name: 'スマートフォルダの名前' })
  await input.fill('あおり')
  await input.press('Enter')
  await expect(folder('あおり')).toBeVisible()
  await expect(title).toHaveText('あおり')

  await folder('あおり').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '削除…' }).click()
  const confirm = page.getByRole('dialog', { name: 'スマートフォルダを削除する' })
  await expect(confirm).toContainText('「あおり」を削除します。画像は変わりません。')
  await confirm.getByRole('button', { name: '削除する' }).click()
  await expect(sidebar.getByRole('heading', { name: 'スマートフォルダ' })).toBeHidden()
  // 絞り込みはそのまま残る
  await expect(status.locator('span').first()).toHaveText(count)
  expect(errors).toEqual([])
})

test('条件のタグやカテゴリが消えていたら、外して開きステータスバーで知らせる', async ({ page }) => {
  await page.goto('/')
  // タグ 99 とカテゴリ 99 はモックのライブラリにない
  await page.evaluate(() =>
    sessionStorage.setItem(
      'mock.smartFolders',
      JSON.stringify([
        {
          id: 1,
          name: '古い条件',
          filter: JSON.stringify({ filter: { category: 99, tags: [1, 99] }, sort: 'rating' }),
        },
      ]),
    ),
  )
  await openGallery(page)
  const sidebar = page.getByRole('navigation', { name: 'サイドバー' })
  await sidebar.getByRole('list', { name: 'スマートフォルダ' }).getByRole('button', { name: '古い条件' }).click()
  const status = page.getByRole('contentinfo')
  await expect(status).toContainText('お知らせ：「古い条件」の条件から、なくなったタグとカテゴリ 2件を外しました')
  await expect(page.getByRole('combobox', { name: '並べ替え' })).toHaveValue('rating')
  await expect(sidebar.getByRole('list', { name: 'タグ' }).getByRole('button', { name: /^あおり/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: 'test-results/smart-folder-dropped.png' })
})
