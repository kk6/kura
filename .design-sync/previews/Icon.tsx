import { Icon, ICONS } from 'kura'

const names = ['imagePlus', 'folderPlus', 'settings', 'trash', 'undo', 'board', 'pin', 'zoomIn'] as const

export const Gallery = () => (
  <div style={{ display: 'flex', gap: 'var(--space-4)', color: 'var(--color-text)' }}>
    {names.map((n) => (
      <Icon key={n} d={ICONS[n]} size={20} />
    ))}
  </div>
)

export const IconButton = () => (
  <button className="button button--icon" aria-label="ゴミ箱に移す">
    <Icon d={ICONS.trash} />
  </button>
)

export const WithLabel = () => (
  <button className="button">
    <Icon d={ICONS.imagePlus} />
    画像を取り込む
  </button>
)
