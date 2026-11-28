import { useEffect, useRef, useState } from 'react'
import Status from './Status'
import './SkipDialog.css'
import './NameDialog.css'

// ボードの新規作成と名前の変更（FR-701）、スマートフォルダの保存（FR-510）。名前は Rust が検査し、エラーは入力欄の下に出す
export default function NameDialog({
  title,
  label = 'ボード名',
  action,
  initial,
  onSubmit,
  onClose,
}: {
  title: string
  // 入力欄の名前。スマートフォルダの保存（FR-510）でも使う
  label?: string
  // 実行するボタンの文言
  action: string
  initial: string
  // 失敗したら理由の文字列で reject する。ダイアログは開いたまま
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
    input.current?.select()
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onSubmit(name)
    } catch (err) {
      setError(String(err))
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="board-name-title" onClose={onClose}>
      <h2 id="board-name-title" className="dialog__title">
        {title}
      </h2>
      <form onSubmit={submit}>
        <label className="board-name">
          {label}
          <input
            ref={input}
            className={error ? 'board-name__input board-name__input--error' : 'board-name__input'}
            value={name}
            aria-invalid={!!error}
            aria-describedby={error ? 'board-name-error' : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </label>
        {error && (
          <span id="board-name-error" role="alert">
            <Status kind="error">{error}</Status>
          </span>
        )}
        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => ref.current?.close()}>
            キャンセル
          </button>
          <button className="button button--primary" disabled={busy}>
            {action}
          </button>
        </div>
      </form>
    </dialog>
  )
}
