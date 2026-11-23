import { useEffect, useRef, useState } from 'react'
import type { Category } from './galleryTypes'
import Status from './Status'
import './SkipDialog.css'

// 差分検出で重複として登録しなかったファイルの「整理…」（FR-109）。登録済みの画像と登録しなかったファイルの、
// どちらの場所に残すかを選ぶ。中身が同じなのでタグは選ばせない。「1枚にまとめる」（FR-610）とは別のダイアログ
export default function TidyDialog({
  name,
  dir,
  existing,
  categories,
  onTidy,
  onClose,
}: {
  // 登録しなかったファイルの名前と、ライブラリからのフォルダ
  name: string
  dir: string
  // 登録済みの画像
  existing: { file_name: string; category_id: number | null }
  categories: Category[]
  // 失敗したら reject する。ダイアログを閉じずに理由を出す
  onTidy: (keepRegistered: boolean) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  const [keepRegistered, setKeepRegistered] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    try {
      await onTidy(keepRegistered)
      ref.current?.close()
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  const choices: [boolean, string, string][] = [
    [true, '登録済みの画像の場所に残す', `${folder(existing.category_id, categories)}/${existing.file_name}`],
    [false, 'このファイルの場所に残す', `${dir}/${name}`],
  ]
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="tidy-title" onClose={onClose}>
      <h2 id="tidy-title" className="dialog__title">
        重複を整理する
      </h2>
      <p>
        「{name}」は、登録済みの画像と中身が同じです。残す場所を選んでください。もう1つのファイルは Kura
        のゴミ箱の下へ移し、ゴミ箱を空にすると消えます。元に戻す操作はありません。
      </p>
      <div className="tidy__choices" role="radiogroup" aria-label="残す場所">
        {choices.map(([value, label, path]) => (
          <label key={label} className="dialog__check tidy__choice">
            <input
              type="radio"
              name="tidy-keep"
              checked={keepRegistered === value}
              onChange={() => setKeepRegistered(value)}
            />
            <span>
              {label}
              <span className="skip__dir tidy__path">{path}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <Status kind="error">{error}</Status>}
      <div className="dialog__actions">
        <button type="button" className="button" onClick={() => ref.current?.close()}>
          キャンセル
        </button>
        <button type="button" className="button button--primary" disabled={busy} onClick={run}>
          整理する
        </button>
      </div>
    </dialog>
  )
}

// カテゴリのフォルダ（ライブラリからの相対パス）。null は未分類
function folder(id: number | null, categories: Category[]): string {
  if (id === null) return '_未分類'
  const c = categories.find((c) => c.id === id)
  if (!c) return ''
  return c.parent_id === null ? c.name : `${folder(c.parent_id, categories)}/${c.name}`
}
