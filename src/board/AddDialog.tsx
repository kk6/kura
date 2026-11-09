import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import Status from '../Status'
import { defaultName } from './names'
import type { Boards, Target } from './types'
import '../SkipDialog.css'
import './Board.css'

const NEW = 'new'

// 「ボードに追加」の追加先を選ぶダイアログ（FR-701）。ギャラリーが開くときに読み込む。
// 「追加」を押すまではボードを作らない。追加すると Rust がボードを専用ウィンドウで開いて手前に出す
export default function AddDialog({ images, onClose }: { images: number[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [boards, setBoards] = useState<Boards | null>(null)
  // 選んだボードの id。NEW は名前を付けた新しいボード
  const [choice, setChoice] = useState<string>('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    invoke<Boards>('list_boards').then(
      (list) => {
        setBoards(list)
        setName(defaultName(list.boards.map((b) => b.name)))
        // ボードを開いていれば、それが最後に使ったボード。最後のボードが消えていれば、最近更新したボード
        const last = list.boards.find((b) => b.id === list.last_board_id) ?? list.boards[0]
        setChoice(last ? String(last.id) : NEW)
      },
      (e) => setError(String(e)),
    )
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !boards) return
    setBusy(true)
    const target: Target = choice === NEW ? { new: name } : { board: Number(choice) }
    try {
      await invoke('add_to_board', { session: boards.session, target, images })
      ref.current?.close()
    } catch (err) {
      setError(String(err))
      setBusy(false)
    }
  }

  const naming = choice === NEW
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="board-add-title" onClose={onClose}>
      <h2 id="board-add-title" className="dialog__title">
        ボードに追加
      </h2>
      <form onSubmit={submit} className="board-add">
        <p>{images.length}枚の画像を追加します。元の画像は複製しません。</p>
        <label className="board-name">
          追加先
          <select
            className="board-name__input"
            value={choice}
            disabled={!boards}
            onChange={(e) => {
              setChoice(e.target.value)
              setError(null)
            }}
          >
            {boards?.boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}（{b.placement_count}枚）
              </option>
            ))}
            <option value={NEW}>新しいボード…</option>
          </select>
        </label>
        {naming && (
          <label className="board-name">
            新しいボードの名前
            <input
              className={error ? 'board-name__input board-name__input--error' : 'board-name__input'}
              value={name}
              aria-invalid={!!error}
              aria-describedby={error ? 'board-add-error' : undefined}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
            />
          </label>
        )}
        {error && (
          <span id="board-add-error" role="alert">
            <Status kind="error">{error}</Status>
          </span>
        )}
        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => ref.current?.close()}>
            キャンセル
          </button>
          <button className="button button--primary" disabled={busy || !boards}>
            追加
          </button>
        </div>
      </form>
    </dialog>
  )
}
