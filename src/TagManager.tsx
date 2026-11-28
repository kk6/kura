import { useState } from 'react'
import { tagsByName } from './choices'
import Status from './Status'
import type { Tag } from './galleryTypes'
import './TagManager.css'

// 1つのタグに対する操作。一度に1つの行だけで行う
type Action =
  | { id: number; kind: 'rename'; name: string }
  | { id: number; kind: 'reading'; reading: string }
  | { id: number; kind: 'merge'; into: number | null }
  | { id: number; kind: 'delete' }

// タグ管理（FR-408）。設定の「タグ」に置く。名前の変更、統合、削除。統合と削除は取り消せないので、行の中で確かめてから行う
export default function TagManager({
  tags,
  counts,
  onRename,
  onReading,
  onMerge,
  onDelete,
}: {
  tags: Tag[]
  // タグの id ごとの、付いている画像の枚数（ゴミ箱を除く）
  counts: Map<number, number>
  // 失敗したら理由の文字列で reject する
  onRename: (id: number, name: string) => Promise<void>
  // 読み仮名（FR-418）
  onReading: (id: number, reading: string) => Promise<void>
  onMerge: (from: number, into: number) => Promise<void>
  onDelete: (id: number) => Promise<void>
}) {
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 一覧を名前で絞り込む文字。比べ方はサイドバーの絞り込み（FR-518）と同じ。操作中のタグは名前を変えても残す
  const [query, setQuery] = useState('')
  const shown = tagsByName(tags, query, new Set(action ? [action.id] : []))

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
    <span id="tag-manager-error">
      <Status kind="error">{error}</Status>
    </span>
  )

  const panel = (a: Action) => {
    if (a.kind === 'rename' || a.kind === 'reading')
      return (
        <div className="tags__panel">
          <input
            autoCorrect="off"
            autoCapitalize="off"
            className={error ? 'tags__input tags__input--error' : 'tags__input'}
            aria-label={`「${nameOf(a.id)}」の${a.kind === 'rename' ? '新しい名前' : '読み仮名'}`}
            placeholder={a.kind === 'reading' ? 'ひらがなかカタカナ' : undefined}
            aria-invalid={!!error}
            aria-describedby={error ? 'tag-manager-error' : undefined}
            value={a.kind === 'rename' ? a.name : a.reading}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              const value = e.target.value
              setAction(a.kind === 'rename' ? { ...a, name: value } : { ...a, reading: value })
              setError(null)
            }}
            onKeyDown={(e) => {
              // かな漢字変換を確定する Enter では変えない（Safari は確定の keydown の keyCode が 229 になる）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') run(a.kind === 'rename' ? onRename(a.id, a.name) : onReading(a.id, a.reading))
              if (e.key === 'Escape') {
                // 設定ごと閉じず（Gallery が window で受ける）、名前の入力だけをやめる
                e.stopPropagation()
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
    <div className="tags">
      <input
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        className="tags__input tags__search"
        type="search"
        placeholder="タグを探す"
        aria-label="タグを名前で絞り込む"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // かな漢字変換を取り消す Escape と、空の欄の Escape は消さない。空なら設定を閉じる（Gallery）
          if (e.key !== 'Escape' || e.nativeEvent.isComposing || !query) return
          e.stopPropagation()
          setQuery('')
        }}
      />
      {tags.length === 0 ? (
        <p className="tags__note">タグはまだありません</p>
      ) : shown.length === 0 ? (
        <p className="tags__note">「{query}」を名前に含むタグはありません</p>
      ) : (
        <ul className="tags__list" aria-label="タグ">
          {shown.map((t) => (
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
                  aria-label={`「${t.name}」の読み仮名を変える`}
                  onClick={() => start({ id: t.id, kind: 'reading', reading: t.reading ?? '' })}
                >
                  読み仮名を変える
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
      )}
    </div>
  )
}
