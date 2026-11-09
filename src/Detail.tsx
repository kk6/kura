import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { useRef, useState } from 'react'
import { CategorySelect, TagEditor } from './Classify'
import { useFlush } from './flush'
import { Icon, ICONS } from './icons'
import Status from './Status'
import type { Category, Detail as DetailData, Image, Tag } from './galleryTypes'

type Props = {
  root: string
  categories: Category[]
  tags: Tag[]
  // 選んでいる画像。1枚だけのときは image にも入る
  ids: number[]
  selected: Image[]
  image: Image | null
  // image の詳細。読み込み中は null
  detail: DetailData | null
  error: string | null
  // 評価を保存して一覧の値も変える。失敗したら reject する
  onRate: (id: number, rating: number) => Promise<void>
  onAssign: (ids: number[], category: number | null) => Promise<void>
  // stem は拡張子より前の部分。失敗したら reject する
  onRename: (id: number, stem: string) => Promise<void>
  onTagCreated: (tag: Tag) => void
  // タグを付けた・外した画像と、保存したメモ。一覧の絞り込みと件数に反映する
  onTagged: (tag: number, ids: number[]) => void
  onUntagged: (tag: number, ids: number[]) => void
  onMemo: (id: number, memo: string) => void
  // 選んだ画像をゴミ箱へ移す（FR-511）
  onTrash: (ids: number[]) => void
  // 選んだ画像の「ボードに追加」。アイデアボードが OFF ならなく、ボタンを出さない（FR-711）
  onAddToBoard?: () => void
  // 画像を Finder で選んだ状態で開く
  onReveal: (id: number) => void
  onClose: () => void
}

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 拡張子から形式の名前を出す。jpg と jpeg はどちらも JPEG
const format = (fileName: string) => {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toUpperCase()
  return ext === 'JPG' ? 'JPEG' : ext
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 詳細パネル（FR-507）。1枚だけ選んでいるときに詳細を出す
// 評価（FR-411）。今の評価と同じ星を押すと評価なし（0）に戻す
function Rating({ image, onRate }: { image: Image; onRate: Props['onRate'] }) {
  const [error, setError] = useState<string | null>(null)
  const rate = (n: number) =>
    onRate(image.id, n === image.rating ? 0 : n).then(
      () => setError(null),
      (e) => setError(String(e)),
    )
  return (
    <>
      <span className="rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className="rating__star"
            aria-label={`評価 ${n}`}
            aria-pressed={n <= image.rating}
            onClick={() => rate(n)}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill={n <= image.rating ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5l-5.5 2.9 1-6.3L3 9.7l6.2-.9z" />
            </svg>
          </button>
        ))}
      </span>
      {error && <Status kind="error">評価を保存できません（{error}）</Status>}
    </>
  )
}

// ファイル名（FR-410）。ダブルクリックで拡張子より前の部分だけを編集する。
// 同名などのエラーでは入力欄を残し、別の名前を入れ直してもらう（カテゴリ名の変更と同じ）
function FileName({ image, onRename }: { image: Image; onRename: Props['onRename'] }) {
  const [editing, setEditing] = useState<{ stem: string; error?: string }>()
  // Rust の fileops::split_ext と同じく、先頭の . は拡張子の区切りとみなさない
  const dot = image.file_name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [image.file_name.slice(0, dot), image.file_name.slice(dot)] : [image.file_name, '']
  if (!editing)
    return (
      <h2 className="detail__name" title="ダブルクリックで名前を変える" onDoubleClick={() => setEditing({ stem })}>
        {image.file_name}
      </h2>
    )
  const commit = () =>
    onRename(image.id, editing.stem).then(
      () => setEditing(undefined),
      (e) => setEditing({ ...editing, error: String(e) }),
    )
  return (
    <>
      <h2 className="detail__name detail__rename">
        <input
          autoCorrect="off"
          autoCapitalize="off"
          className={editing.error ? 'detail__input detail__input--error' : 'detail__input'}
          aria-label="ファイル名（拡張子を除く）"
          aria-invalid={!!editing.error}
          aria-describedby={editing.error ? 'detail-name-error' : undefined}
          value={editing.stem}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setEditing({ stem: e.target.value })}
          onKeyDown={(e) => {
            // かな漢字変換を確定する Enter では変えない
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
            if (e.key === 'Escape') setEditing(undefined)
          }}
          onBlur={() => setEditing(undefined)}
        />
        {ext}
      </h2>
      {editing.error && (
        <span id="detail-name-error">
          <Status kind="error">{editing.error}</Status>
        </span>
      )}
    </>
  )
}

// メモ（FR-411）。入力欄から離れたときと、閉じる・終了・切り替えの前に保存する
function Memo({ id, initial, onSaved }: { id: number; initial: string; onSaved: (memo: string) => void }) {
  const [saved, setSaved] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const save = async (memo: string) => {
    if (memo === saved) return
    try {
      await invoke('set_memo', { id, memo })
    } catch (e) {
      setError(String(e))
      throw `メモを保存できません（${e}）`
    }
    setSaved(memo)
    setError(null)
    onSaved(memo)
  }
  useFlush(() => (input.current ? save(input.current.value) : Promise.resolve()))
  return (
    <>
      <textarea
        autoCorrect="off"
        autoCapitalize="off"
        id="detail-memo"
        className={error ? 'detail__memo detail__memo--error' : 'detail__memo'}
        ref={input}
        defaultValue={initial}
        // 失敗は入力欄の下に出す
        onBlur={(e) => save(e.target.value).catch(() => {})}
        aria-invalid={!!error}
        aria-describedby={error ? 'detail-memo-error' : undefined}
      />
      {error && (
        <span id="detail-memo-error">
          <Status kind="error">メモを保存できません（{error}）</Status>
        </span>
      )}
    </>
  )
}

export default function Detail(props: Props) {
  const { root, categories, tags, ids, selected, image, detail, error, onRate, onAssign, onRename } = props
  // カテゴリとタグは、1枚でも複数でも同じ部品で変える
  const classify = (
    <>
      <dt>
        <label htmlFor="detail-category">カテゴリ</label>
      </dt>
      <dd>
        <CategorySelect selected={selected} categories={categories} onAssign={onAssign} />
      </dd>
      <dt>
        <label htmlFor="detail-tag">タグ</label>
      </dt>
      <dd>
        {/* key：選び直したら、付けていない入力中のタグを消す。前の選択に付いたのか見分けにくいため */}
        <TagEditor
          key={ids.join(',')}
          ids={ids}
          tags={tags}
          onCreated={props.onTagCreated}
          onTagged={props.onTagged}
          onUntagged={props.onUntagged}
        />
      </dd>
    </>
  )
  const add = props.onAddToBoard && (
    <button type="button" className="button" title="ボードに追加（⇧⌘B）" onClick={props.onAddToBoard}>
      <Icon d={ICONS.board} />
      ボードに追加
    </button>
  )
  // 元に戻せるので確認は出さない
  const trash = (
    <button type="button" className="button" onClick={() => props.onTrash(ids)}>
      <Icon d={ICONS.trash} />
      ゴミ箱へ移す
    </button>
  )
  return (
    <aside className="gallery__detail" aria-label="詳細">
      <div className="detail__header">
        {/* 見出しにはしない。パネルは aside の名前で読み上げ、見出しはファイル名にするため */}
        <span className="detail__title">画像の詳細</span>
        <button
          type="button"
          className="button button--icon button--bare"
          aria-label="詳細パネルを閉じる"
          title="詳細パネルを閉じる（⌘I）"
          onClick={props.onClose}
        >
          <Icon d={ICONS.x} />
        </button>
      </div>
      {!selected.length ? (
        <p className="detail__empty">画像を選ぶと、ここに詳細が出ます</p>
      ) : !image ? (
        <>
          <h2 className="detail__name">{selected.length}枚を選んでいます</h2>
          <dl className="detail__fields">{classify}</dl>
          <div className="detail__actions">
            {add}
            {trash}
          </div>
        </>
      ) : (
        <>
          <div className="detail__preview">
            <img
              src={convertFileSrc(`${root}/.kura/thumbs/${image.hash}.jpg`)}
              alt={`${image.file_name} のプレビュー`}
              style={{
                // 高さの上限（--size-detail）に収まる幅にする。読み込むまでも枠の大きさを保つため
                width: `min(100%, calc(var(--size-detail) * ${image.width / image.height}))`,
                aspectRatio: `${image.width} / ${image.height}`,
                background: image.color,
              }}
            />
          </div>
          {/* key：別の画像に移ったら入力中の名前を捨てる */}
          <FileName key={image.id} image={image} onRename={onRename} />
          <p className="detail__meta">
            {format(image.file_name)} ・ {image.width} × {image.height}
            {detail && ` ・ ${fileSize(detail.file_size)}`}
          </p>
          <Rating image={image} onRate={onRate} />
          {error && <Status kind="error">詳細を読めません（{error}）</Status>}
          <dl className="detail__fields">
            {classify}
            <dt>元URL</dt>
            {/* shortcut: 文字として出すだけで、ブラウザでは開けない。ダウンロード元の記録（FR-208、フェーズ2）で元URLが入るようになったら開けるようにする */}
            <dd className="detail__url">{detail && (detail.source?.page_url ?? detail.source?.image_url ?? 'なし')}</dd>
            <dt>
              <label htmlFor="detail-memo">メモ</label>
            </dt>
            {/* key：別の画像に移ったら入力欄を作り直し、その画像のメモで始める */}
            <dd>
              <Memo
                key={image.id}
                id={image.id}
                initial={image.memo}
                onSaved={(memo) => props.onMemo(image.id, memo)}
              />
            </dd>
            <dt>取り込み日</dt>
            <dd>{dateTime(image.imported_at)}</dd>
          </dl>
          <div className="detail__actions">
            {add}
            <button type="button" className="button" onClick={() => props.onReveal(image.id)}>
              <Icon d={ICONS.folder} />
              Finderで表示
            </button>
            {trash}
          </div>
        </>
      )}
    </aside>
  )
}
