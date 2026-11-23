import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { CategorySelect } from './Classify'
import type { Category, Detail, Image, Tag } from './galleryTypes'
import { defaultKeep, unionTags } from './merge'
import Status from './Status'
import './SkipDialog.css'
import './Classify.css'
import './Detail.css'
import './CategoryDialog.css'
import './MergeDialog.css'

// 「1枚にまとめる…」（FR-610）。残す1枚、そのカテゴリとタグを選び、ゴミ箱へ移す枚数を見せて確かめてから実行する。
// 類似画像検索の結果からと、ライブラリ全体から探した組（FR-611）の両方で使う
export default function MergeDialog({
  root,
  images,
  categories,
  tags,
  onMerge,
  onClose,
}: {
  root: string
  images: Image[]
  categories: Category[]
  tags: Tag[]
  // 失敗したら reject する。ダイアログを閉じずに理由を出す
  onMerge: (keep: number, category: number | null, tags: number[]) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  // 初期値はファイルサイズも見て選ぶので、詳細を読むまで決まらない
  const [keep, setKeep] = useState<number | null>(null)
  const [category, setCategory] = useState<number | null>(null)
  const [chosen, setChosen] = useState(() => unionTags(images))
  const [step, setStep] = useState<'choose' | 'confirm'>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (id: number) => {
    setKeep(id)
    setCategory(images.find((i) => i.id === id)!.category_id)
  }
  useEffect(() => {
    // 読めない画像はファイルサイズを比べない。画素数と取り込み日時で選ぶ
    Promise.all(
      images.map((i) =>
        invoke<Detail>('image_detail', { id: i.id }).then(
          (d) => d.file_size,
          () => 0,
        ),
      ),
    ).then((sizes) => choose(defaultKeep(images.map((i, n) => ({ ...i, file_size: sizes[n] })))))
    // 開いたときの画像で1度だけ選ぶ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const kept = images.find((i) => i.id === keep)
  const names = new Map(tags.map((t) => [t.id, t.name]))

  async function run() {
    setBusy(true)
    try {
      await onMerge(keep!, category, chosen)
      ref.current?.close()
    } catch (e) {
      setError(String(e))
      setStep('choose')
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog category-dialog" aria-labelledby="merge-title" onClose={onClose}>
      <h2 id="merge-title" className="dialog__title">
        {images.length}枚を1枚にまとめる
      </h2>
      {step === 'confirm' && kept ? (
        <>
          <p>
            「{kept.file_name}」を残し、ほかの{images.length - 1}枚をゴミ箱へ移します。ゴミ箱から元に戻せます。
          </p>
          <div className="dialog__actions">
            <button type="button" className="button" onClick={() => setStep('choose')}>
              戻る
            </button>
            <button type="button" className="button button--primary" disabled={busy} onClick={run}>
              ゴミ箱へ移す
            </button>
          </div>
        </>
      ) : (
        <>
          <p>残す1枚を選んでください。ほかの画像はゴミ箱へ移します。</p>
          <div className="merge__images" role="radiogroup" aria-label="残す画像">
            {images.map((i) => (
              <label key={i.id} className="merge__image">
                <span className="merge__thumb">
                  <img
                    src={convertFileSrc(`${root}/.kura/thumbs/${i.hash}.jpg`)}
                    alt=""
                    // 読み込むまでも枠を保つよう、長い辺を枠に合わせる
                    style={{
                      aspectRatio: `${i.width} / ${i.height}`,
                      background: i.color,
                      [i.width >= i.height ? 'width' : 'height']: '100%',
                    }}
                  />
                </span>
                <span className="merge__choice">
                  <input
                    type="radio"
                    name="merge-keep"
                    checked={i.id === keep}
                    disabled={keep === null}
                    onChange={() => choose(i.id)}
                  />
                  <span className="merge__name">{i.file_name}</span>
                </span>
                <span className="merge__meta">
                  {i.width} × {i.height}
                </span>
              </label>
            ))}
          </div>
          {kept && (
            <dl className="merge__fields">
              <dt>
                <label htmlFor="merge-category">残す画像のカテゴリ</label>
              </dt>
              <dd>
                <CategorySelect
                  // 残す画像を選び直したら、その画像のカテゴリで始める
                  key={kept.id}
                  id="merge-category"
                  selected={[{ ...kept, category_id: category }]}
                  categories={categories}
                  onAssign={async (_, c) => setCategory(c)}
                />
              </dd>
              <dt>残す画像のタグ</dt>
              <dd>
                {chosen.length ? (
                  <ul className="detail__tags">
                    {chosen.map((t) => (
                      <li key={t} className="tag">
                        {names.get(t)}
                        <button
                          type="button"
                          className="tag__remove"
                          aria-label={`${names.get(t)} を外す`}
                          onClick={() => setChosen((c) => c.filter((x) => x !== t))}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            aria-hidden="true"
                          >
                            <path d="M7 7l10 10M17 7L7 17" />
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  'なし'
                )}
              </dd>
            </dl>
          )}
          <p className="merge__note">
            元URLは、残す画像になければほかの画像のものを引き継ぎます。メモは引き継ぎません。ボードに置いた画像は、残す画像に置き換わります。
          </p>
          {error && (
            <span role="alert">
              <Status kind="error">まとめられません（{error}）</Status>
            </span>
          )}
          <div className="dialog__actions">
            <button type="button" className="button" onClick={() => ref.current?.close()}>
              キャンセル
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!kept}
              onClick={() => setStep('confirm')}
            >
              まとめる…
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}
