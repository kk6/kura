import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Image } from './galleryTypes'
import { layout, visible } from './layout'

type Props = { root: string; images: Image[]; thumbWidth: number }

export default function Masonry({ root, images, thumbWidth }: Props) {
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

  // スクロールのたびに描き直さず、1フレームに1回だけ反映する
  const onScroll = () => {
    const el = ref.current!
    requestAnimationFrame(() => setScrollTop(el.scrollTop))
  }

  // 表示範囲の上下に1画面分ずつ余分に描いておく
  const shown = l ? visible(l, scrollTop - gap - height, scrollTop - gap + height * 2) : []

  return (
    <main ref={ref} className="gallery__list" aria-label="画像の一覧" onScroll={onScroll}>
      {images.length === 0 ? (
        <p className="list__empty">画像がありません。「画像を取り込む」を押すか、画像をここにドロップしてください</p>
      ) : (
        l && (
          <div className="list__canvas" style={{ height: l.height + gap * 2 }}>
            {shown.map((i) => (
              <img
                key={images[i].id}
                className="list__thumb"
                src={convertFileSrc(`${root}/.kura/thumbs/${images[i].hash}.jpg`)}
                alt={images[i].file_name}
                decoding="async"
                style={{
                  width: l.columnWidth,
                  height: l.h[i],
                  transform: `translate(${l.x[i] + gap}px, ${l.y[i] + gap}px)`,
                  // 読み込むまでは代表色で埋めて、空白に見えないようにする
                  background: images[i].color,
                }}
              />
            ))}
          </div>
        )
      )}
    </main>
  )
}
