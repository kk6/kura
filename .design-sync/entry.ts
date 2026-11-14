// Claude Design に同期する部品の入口（.design-sync/config.json の entry）。
// Kura はアプリで dist/ を持たないため、Tauri の invoke に頼らない部品だけをここで書き出す
import '../src/styles/tokens.css'
import '../src/styles/base.css'

export { default as ConfirmDialog } from '../src/ConfirmDialog.tsx'
export { default as Status } from '../src/Status.tsx'
export { Icon, ICONS } from '../src/icons.tsx'
