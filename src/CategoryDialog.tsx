import { type FormEvent, useEffect, useRef, useState } from 'react'
import { CategorySelect } from './Classify'
import { categoryOptions } from './choices'
import type { Category, Image } from './galleryTypes'
import Status from './Status'
import './SkipDialog.css'
import './Classify.css'
import './CategoryDialog.css'

// 右クリックの「カテゴリを変える…」（FR-416）。既存のカテゴリは詳細パネルと同じ欄で選んですぐ移し、
// 新しいカテゴリは名前と作る場所を入れて作ってから移す
export default function CategoryDialog({
  selected,
  categories,
  onAssign,
  onCreate,
  onClose,
}: {
  selected: Image[]
  categories: Category[]
  onAssign: (ids: number[], category: number | null) => Promise<void>
  // 作ったカテゴリの id を返す。名前の扱いと作れないときのエラーはサイドバーからの作成（FR-401）と同じ
  onCreate: (parent: number | null, name: string) => Promise<number>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => ref.current?.showModal(), [])

  // 移せなかった画像はステータスバーに出す。全体が失敗したら閉じずに欄の下にエラーを出す
  const assign = async (ids: number[], category: number | null) => {
    await onAssign(ids, category)
    ref.current?.close()
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const id = await onCreate(parent ? Number(parent) : null, name)
      await assign(
        selected.map((i) => i.id),
        id,
      )
    } catch (err) {
      setError(String(err))
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog category-dialog" aria-labelledby="category-dialog-title" onClose={onClose}>
      <h2 id="category-dialog-title" className="dialog__title">
        {selected.length}枚の画像のカテゴリを変える
      </h2>
      <div className="category-dialog__field">
        <label htmlFor="category-dialog-select">移す先</label>
        <CategorySelect id="category-dialog-select" selected={selected} categories={categories} onAssign={assign} />
      </div>
      <form onSubmit={create} className="category-dialog__new">
        <label className="category-dialog__field">
          新しいカテゴリ
          <input
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className={error ? 'tag-input__field tag-input__field--error' : 'tag-input__field'}
            value={name}
            aria-invalid={!!error}
            aria-describedby={error ? 'category-dialog-error' : undefined}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </label>
        <label className="category-dialog__field">
          作る場所
          <select className="tag-input__field" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">ルート直下</option>
            {categoryOptions(categories).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <span id="category-dialog-error" role="alert">
            <Status kind="error">{error}</Status>
          </span>
        )}
        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => ref.current?.close()}>
            キャンセル
          </button>
          <button className="button button--primary" disabled={busy || !name.trim()}>
            作って移す
          </button>
        </div>
      </form>
    </dialog>
  )
}
