import { useEffect, useRef, useState } from 'react'
import Status from './Status'
import type { Tag } from './galleryTypes'
import './SkipDialog.css'
import './TagDialog.css'

// 1つのタグに対する操作。一度に1つの行だけで行う
type Action =
  | { id: number; kind: 'rename'; name: string }
  | { id: number; kind: 'merge'; into: number | null }
  | { id: number; kind: 'delete' }

// タグ管理（FR-408）。名前の変更、統合、削除。統合と削除は取り消せないので、行の中で確かめてから行う
export default function TagDialog({
  tags,
  counts,
  onRename,
  onMerge,
  onDelete,
  onClose,
}: {
  tags: Tag[]
  // タグの id ごとの、付いている画像の枚数（ゴミ箱を除く）
  counts: Map<number, number>
  // 失敗したら理由の文字列で reject する
  onRename: (id: number, name: string) => Promise<void>
  onMerge: (from: number, into: number) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => ref.current?.showModal(), [])

  const start = (next: Action | null) => {
    setAction(next)
    setError(null)
  }
  const run = async (op: Promise<void>) => {
    try {
      await op
      start(null)
    } catch (e) {
      setError(String(e))
    }
  }
  const nameOf = (id: number) => tags.find((t) => t.id === id)?.name ?? ''
  const count = (id: number) => counts.get(id) ?? 0
  const errorLine = error && (
    <span id="tag-dialog-error">
      <Status kind="error">{error}</Status>
    </span>
  )

  const panel = (a: Action) => {
    if (a.kind === 'rename')
      return (
        <div className="tags__panel">
          <input
            autoCorrect="off"
            autoCapitalize="off"
            className={error ? 'tags__input tags__input--error' : 'tags__input'}
            aria-label={`「${nameOf(a.id)}」の新しい名前`}
            aria-invalid={!!error}
            aria-describedby={error ? 'tag-dialog-error' : undefined}
            value={a.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setAction({ ...a, name: e.target.value })
              setError(null)
            }}
            onKeyDown={(e) => {
              // かな漢字変換を確定する Enter では変えない（Safari は確定の keydown の keyCode が 229 になる）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') run(onRename(a.id, a.name))
              if (e.key === 'Escape') {
                // ダイアログごと閉じず、名前の入力だけをやめる
                e.preventDefault()
                start(null)
              }
            }}
          />
          {errorLine}
        </div>
      )
    if (a.kind === 'merge')
      return (
        <div className="tags__panel">
          <label className="tags__field">
            統合先
            <select
              className="tags__select"
              value={a.into ?? ''}
              autoFocus
              onChange={(e) => start({ ...a, into: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">選ぶ</option>
              {tags
                .filter((t) => t.id !== a.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          {a.into !== null && (
            <p className="tags__note">
              「{nameOf(a.id)}」の {count(a.id)}枚に「{nameOf(a.into)}」を付け、「{nameOf(a.id)}
              」を削除します。両方が付いている画像は「
              {nameOf(a.into)}」1つになります。
            </p>
          )}
          {errorLine}
          <span className="tags__buttons">
            <button type="button" className="button" onClick={() => start(null)}>
              キャンセル
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={a.into === null}
              onClick={() => a.into !== null && run(onMerge(a.id, a.into))}
            >
              統合する
            </button>
          </span>
        </div>
      )
    return (
      <div className="tags__panel">
        <p className="tags__note">
          「{nameOf(a.id)}」を {count(a.id)}枚から外して削除します。画像は削除しません。
        </p>
        {errorLine}
        <span className="tags__buttons">
          {/* 取り消せない操作なので、Enter を押しただけでは削除しないようキャンセルを選んでおく */}
          <button type="button" className="button" autoFocus onClick={() => start(null)}>
            キャンセル
          </button>
          <button type="button" className="button button--primary" onClick={() => run(onDelete(a.id))}>
            削除する
          </button>
        </span>
      </div>
    )
  }

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="tag-dialog-title" onClose={onClose}>
      <h2 id="tag-dialog-title" className="dialog__title">
        タグを管理する
      </h2>
      {tags.length ? (
        <ul className="skip__list" aria-label="タグ">
          {tags.map((t) => (
            <li key={t.id} className="tags__item">
              <span className="tags__row">
                <span className="tags__name">{t.name}</span>
                <span className="tags__count">{count(t.id)}枚</span>
                <button
                  type="button"
                  className="button tags__action"
                  aria-label={`「${t.name}」の名前を変える`}
                  onClick={() => start({ id: t.id, kind: 'rename', name: t.name })}
                >
                  名前を変える
                </button>
                <button
                  type="button"
                  className="button tags__action"
                  aria-label={`「${t.name}」を統合する`}
                  disabled={tags.length < 2}
                  onClick={() => start({ id: t.id, kind: 'merge', into: null })}
                >
                  統合する
                </button>
                <button
                  type="button"
                  className="button tags__action"
                  aria-label={`「${t.name}」を削除する`}
                  onClick={() => start({ id: t.id, kind: 'delete' })}
                >
                  削除する
                </button>
              </span>
              {action?.id === t.id && panel(action)}
            </li>
          ))}
        </ul>
      ) : (
        <p>タグはまだありません</p>
      )}
      <form method="dialog" className="dialog__actions">
        <button className="button">閉じる</button>
      </form>
    </dialog>
  )
}
