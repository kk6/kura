import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import Status from './Status'
import type { Category, Detail as DetailData, Image } from './galleryTypes'

type Props = { root: string; categories: Category[]; image: Image | null; count: number }

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
export default function Detail({ root, categories, image, count }: Props) {
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const id = image?.id
  useEffect(() => {
    if (id === undefined) return
    let current = true
    setDetail(null)
    setError(null)
    invoke<DetailData>('image_detail', { id }).then(
      (d) => current && setDetail(d),
      (e) => current && setError(String(e)),
    )
    return () => {
      current = false
    }
  }, [id])

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
            <dt>メモ</dt>
            <dd className="detail__memo">{detail && (detail.memo || 'なし')}</dd>
          </dl>
        </>
      )}
    </aside>
  )
}
