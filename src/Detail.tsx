import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import Status from './Status'
import type { Category, Detail as DetailData, Image } from './galleryTypes'

type Props = {
  root: string
  categories: Category[]
  image: Image | null
  count: number
  // image の詳細。読み込み中は null
  detail: DetailData | null
  error: string | null
  // 評価を保存して一覧の値も変える。失敗したら reject する
  onRate: (id: number, rating: number) => Promise<void>
}

function categoryPath(categories: Category[], id: number | null): string {
  const names = []
  for (let c = categories.find((c) => c.id === id); c; c = categories.find((p) => p.id === c!.parent_id))
    names.unshift(c.name)
  return names.length ? names.join(' / ') : '未分類'
}

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
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

// メモ（FR-411）。入力欄から離れたときに保存する
function Memo({ id, initial }: { id: number; initial: string }) {
  const [saved, setSaved] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const save = (memo: string) => {
    if (memo === saved) return
    invoke('set_memo', { id, memo }).then(
      () => {
        setSaved(memo)
        setError(null)
      },
      (e) => setError(String(e)),
    )
  }
  return (
    <>
      <textarea
        id="detail-memo"
        className={error ? 'detail__memo detail__memo--error' : 'detail__memo'}
        defaultValue={initial}
        onBlur={(e) => save(e.target.value)}
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

export default function Detail({ root, categories, image, count, detail, error, onRate }: Props) {
  return (
    <aside className="gallery__detail" aria-label="詳細">
      {!image ? (
        <p className="detail__empty">
          {count ? `${count}枚を選んでいます` : '画像を選ぶと、ここに詳細が出ます'}
        </p>
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
          <h2 className="detail__name">{image.file_name}</h2>
          {error && <Status kind="error">詳細を読めません（{error}）</Status>}
          <dl className="detail__fields">
            <dt>カテゴリ</dt>
            <dd>{categoryPath(categories, image.category_id)}</dd>
            <dt>タグ</dt>
            <dd>
              {detail?.tags.length ? (
                <ul className="detail__tags">
                  {detail.tags.map((t) => (
                    <li key={t.id} className="tag">
                      {t.name}
                    </li>
                  ))}
                </ul>
              ) : (
                detail && 'なし'
              )}
            </dd>
            <dt>元URL</dt>
            {/* shortcut: 文字として出すだけで、ブラウザでは開けない。URL 取り込み（フェーズ2）で元URLが入るようになったら開けるようにする */}
            <dd className="detail__url">{detail && (detail.source?.page_url ?? detail.source?.image_url ?? 'なし')}</dd>
            <dt>サイズ</dt>
            <dd>
              {image.width} × {image.height}
              {detail && `、${fileSize(detail.file_size)}`}
            </dd>
            <dt>評価</dt>
            <dd>
              <Rating image={image} onRate={onRate} />
            </dd>
            <dt>
              <label htmlFor="detail-memo">メモ</label>
            </dt>
            {/* key：別の画像に移ったら入力欄を作り直し、その画像のメモで始める */}
            <dd>{detail && <Memo key={image.id} id={image.id} initial={detail.memo} />}</dd>
          </dl>
        </>
      )}
    </aside>
  )
}
