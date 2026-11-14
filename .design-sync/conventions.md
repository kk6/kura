# Kura design conventions

Kura is a macOS desktop app for browsing illustration reference images. The images are the subject; the UI must stay out of their way. Write all UI text in Japanese.

## Hard rules

- Colors: white, black, and grays only, via the `--color-*` tokens. The only accent colors are the four status tokens `--color-error`, `--color-warning`, `--color-success`, `--color-info`, and only for status messages (use `<Status>`).
- Never use gradients, shadows, glassmorphism/blur, emoji icons, left-border accent cards, or radii above `--radius-md` (4px). `--radius-full` is reserved for an AND/OR toggle.
- Never write raw values for color, font size, spacing, or radius. Use the tokens below.
- Selection is shown with a black outline (`--select-outline`) or a gray background (`--color-selected`), never with color.
- Dense layouts: prefer showing more images over generous whitespace.

## Setup

No provider is needed. `styles.css` defines every token on `:root` and the base element styles (system font, `--font-size-md` body text, `--color-surface` background). Image grids sit on `--color-bg` (neutral gray).

## Tokens (`var(--*)`)

- Color: `--color-bg`, `--color-surface`, `--color-input`, `--color-raise` (hover), `--color-selected`, `--color-line`, `--color-text`, `--color-text-sub`, `--color-text-faint`, `--color-on-text` (text on black)
- Type: `--font-size-sm|md|lg|xl` (12/13/14/16px), `--font-weight-regular|bold`, `--line-height`
- Space: `--space-1`…`--space-5` (4/6/8/12/16px)
- Shape: `--radius-sm`, `--radius-md`, `--border`, `--focus-ring`
- Sizes: `--size-header`, `--size-sidebar`, `--size-detail`, `--size-statusbar`, `--size-toolbar`, `--size-control` (32px), `--size-control-sm`, `--size-dialog`
- Motion: `--duration-fast`, `--duration-base`, `--duration-panel`

## Classes

- Buttons: `button` (outlined, gray), `button button--primary` (black fill, the one main action), `button button--icon` (square, icon only; give it `aria-label`)
- Dialog: `dialog` on a `<dialog>`, with `dialog__title`, `dialog__section`, `dialog__row`, `dialog__actions` (right-aligned buttons, cancel first)
- Popover menu: `menu`, `menu__item`, `menu__rule`
- Range input: `slider`

## Components (`window.Kura`)

- `Status` — status line with color + icon shape + Japanese prefix (エラー：/注意：/完了：/お知らせ：)
- `ConfirmDialog` — modal confirm before an irreversible action; say what is lost, with a count
- `Icon` + `ICONS` — 2px line icons (Lucide style). Pass a path from `ICONS`, e.g. `ICONS.trash`, `ICONS.imagePlus`, `ICONS.settings`

Full rules: `guidelines/docs/design.md`.

## Example

```jsx
const { Icon, ICONS, Status } = window.Kura
<div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', height: 'var(--size-toolbar)', padding: '0 var(--space-4)', borderBottom: 'var(--border)', background: 'var(--color-surface)' }}>
  <button className="button button--primary"><Icon d={ICONS.imagePlus} />画像を取り込む</button>
  <button className="button button--icon" aria-label="設定"><Icon d={ICONS.settings} /></button>
  <Status kind="success">48件を取り込みました</Status>
</div>
```
