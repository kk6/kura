import { getCurrentWindow } from '@tauri-apps/api/window'

// メニューのキーと同じ項目（src-tauri/src/menu.rs の KEYS）。選ぶと Rust が手前のウィンドウへ edit-menu で送る。
// command があるのは「編集」の項目で、入力欄では文字に効かせる。ほかはいつも同じキーとして渡す（6章）
type Edit = 'undo' | 'redo' | 'select-all' | 'settings' | 'find' | 'detail' | 'trash'

const EDITS: Record<Edit, { command?: string; key: KeyboardEventInit }> = {
  undo: { command: 'undo', key: { key: 'z', code: 'KeyZ', metaKey: true } },
  redo: { command: 'redo', key: { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true } },
  'select-all': { command: 'selectAll', key: { key: 'a', code: 'KeyA', metaKey: true } },
  settings: { key: { key: ',', code: 'Comma', metaKey: true } },
  find: { key: { key: 'f', code: 'KeyF', metaKey: true } },
  detail: { key: { key: 'i', code: 'KeyI', metaKey: true } },
  trash: { key: { key: 'Backspace', code: 'Backspace', metaKey: true } },
}

// 文字を編集できる所。不透明度のスライダーなどは含めない
const TEXT = 'textarea, input:is([type=text], [type=search], :not([type])), [contenteditable]'

// 入力欄では文字に効かせ、それ以外は同じショートカットのキーとして画面に渡す。メニューから選んでも
// キーを押しても、ボードの配置やギャラリーの画像に同じ操作が効く（NFR-12）。
// 画面がキーを受けて止めたときは、メニューには届かないので二重には効かない
export async function serveEditMenu() {
  await getCurrentWindow().listen<Edit>('edit-menu', ({ payload }) => {
    const edit = EDITS[payload]
    const at = document.activeElement ?? document.body
    // 自前のメニューの項目からは、入力欄の標準の取り消しなどを呼べないので execCommand で行う
    if (edit.command && at.matches(TEXT)) document.execCommand(edit.command)
    else at.dispatchEvent(new KeyboardEvent('keydown', { ...edit.key, bubbles: true, cancelable: true }))
  })
}
