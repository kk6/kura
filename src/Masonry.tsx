import { Icon, ICONS } from './icons'
import { convertFileSrc } from '@tauri-apps/api/core'
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Image } from './galleryTypes'
import { type Arrow, layout, neighbor, visible } from './layout'

type Props = {
  root: string
  images: Image[]
  // 1枚もないときに出す文言
  empty: string
  thumbWidth: number
  selected: Set<number>
  // id が null のときは画像のない所を押した
  onSelect: (id: number | null, e: MouseEvent) => void
  onOpen: () => void
  // 画像の右クリック。なければ WebView の初期のメニューを出す
  onContextMenu?: (id: number, e: MouseEvent) => void
  // 矢印キーで選択を動かす（NFR-12）。active は動かす元の画像。keys が false の間（拡大表示中など）は受けない
  active: number | null
  keys: boolean
  onMove: (id: number) => void
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

export default function Masonry({
  root,
  images,
  empty,
  thumbWidth,
  selected,
  onSelect,
  onContextMenu,
  onOpen,
  active,
  keys,
  onMove,
}: Props) {
  const ref = useRef<HTMLElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0, gap: 0 })

  useEffect(() => {
    const el = ref.current!
    const measure = () =>
      setViewport({
        width: el.clientWidth,
        height: el.clientHeight,
        // 配置の計算に数値が要るので、サムネイルの間隔のトークンを読む
        gap: parseFloat(getComputedStyle(el).getPropertyValue('--space-2')),
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    ref.current!.scrollTop = 0
  }, [images])

  const { width, height, gap } = viewport
  const l = useMemo(
    () => (width ? layout(images, width - gap * 2, thumbWidth, gap) : undefined),
    [images, width, gap, thumbWidth],
  )

  useEffect(() => {
    if (!keys || !l) return
    const onKey = (e: KeyboardEvent) => {
      if (!ARROWS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as Element).closest('input, textarea, select, dialog')) return
      const at = active === null ? -1 : images.findIndex((i) => i.id === active)
      const next = at < 0 ? 0 : neighbor(l, at, e.key as Arrow)
      if (next === undefined || !images[next]) return
      e.preventDefault()
      // 移った画像が見えるようにスクロールする
      const el = ref.current!
      const top = l.y[next] + gap
      const bottom = top + l.h[next]
      if (top < el.scrollTop) el.scrollTop = top - gap
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom + gap - el.clientHeight
      onMove(images[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys, l, images, active, gap, onMove])

  // スクロールのたびに描き直さず、1フレームに1回だけ反映する
  const onScroll = () => {
    const el = ref.current!
    requestAnimationFrame(() => setScrollTop(el.scrollTop))
  }

  // 表示範囲の上下に1画面分ずつ余分に描いておく
  const shown = l ? visible(l, scrollTop - gap - height, scrollTop - gap + height * 2) : []

  return (
    <main
      ref={ref}
      className="gallery__list"
      aria-label="画像の一覧"
      onScroll={onScroll}
      onClick={(e) => {
        const id = (e.target as HTMLElement).dataset.id
        onSelect(id ? Number(id) : null, e)
      }}
      // 1回目のクリックでその画像だけが選ばれている
      onContextMenu={(e) => {
        const id = (e.target as HTMLElement).dataset.id
        if (id && onContextMenu) onContextMenu(Number(id), e)
      }}
      onDoubleClick={(e) => (e.target as HTMLElement).dataset.id && !e.shiftKey && !e.metaKey && onOpen()}
    >
      {images.length === 0 ? (
        <p className="list__empty">{empty}</p>
      ) : (
        l && (
          <div className="list__canvas" style={{ height: l.height + gap * 2 }}>
            {shown.map((i) => [
              <img
                key={images[i].id}
                className={selected.has(images[i].id) ? 'list__thumb list__thumb--selected' : 'list__thumb'}
                src={convertFileSrc(`${root}/.kura/thumbs/${images[i].hash}.jpg`)}
                alt={images[i].file_name}
                decoding="async"
                data-id={images[i].id}
                style={{
                  width: l.columnWidth,
                  height: l.h[i],
                  transform: `translate(${l.x[i] + gap}px, ${l.y[i] + gap}px)`,
                  // 読み込むまでは代表色で埋めて、空白に見えないようにする
                  background: images[i].color,
                }}
              />,
              // 枠だけでは選択中かが見分けにくいので、左上に印を重ねる。表示だけで、押しても何も起きない
              selected.has(images[i].id) && (
                <span
                  key={`check${images[i].id}`}
                  className="list__check"
                  aria-hidden="true"
                  style={{ transform: `translate(${l.x[i] + gap}px, ${l.y[i] + gap}px)` }}
                >
                  <Icon d={ICONS.check} size={12} />
                </span>
              ),
            ])}
          </div>
        )
      )}
    </main>
  )
}
