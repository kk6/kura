import { convertFileSrc } from '@tauri-apps/api/core'
import { useLayoutEffect, useRef, useState } from 'react'
import type { Board, Geometry, Item, Viewport } from './types'

// 状態ごとの枠の文言。元画像がないので、画像やサムネイルの代わりに出す（FR-701）
const STATUS = { trashed: 'ゴミ箱にあります', missing: '見つからない', deleted: '削除された画像' } as const

// 全体が見える表示にするときに、ウィンドウの端から空ける幅
const FIT_MARGIN = 48

type Drag = { id: number; pointer: number; startX: number; startY: number; dx: number; dy: number }

// ボードのキャンバス。配置はボード上の座標で持ち、表示の位置と倍率（viewport）で画面の座標に直して描く。
// 選択枠を倍率に関係なく同じ太さで描くため、拡大した層を重ねず1枚ずつ画面の座標に置く
export default function Canvas({
  board,
  paths,
  viewport,
  selected,
  fit,
  onViewport,
  onFitted,
  onSelect,
  onMove,
}: {
  board: Board
  // 画像 ID から元画像のパス。読み込むまでは枠だけを出す
  paths: Record<number, string>
  viewport: Viewport
  selected: Set<number>
  // この配置がすべて見える位置と倍率に表示を移す。移したら onFitted を呼ぶ
  fit: number[] | null
  onViewport: (viewport: Viewport) => void
  onFitted: () => void
  onSelect: (ids: number[]) => void
  // ドラッグを終えた位置。ボード上の座標
  onMove: (id: number, x: number, y: number) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<Drag | null>(null)

  useLayoutEffect(() => {
    const el = ref.current!
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!fit || !size.width) return
    const box = bounds(board.items.filter((i) => fit.includes(i.id)).map((i) => i.geometry))
    if (box) {
      const scale = Math.min(
        (size.width - FIT_MARGIN * 2) / (box.right - box.left),
        (size.height - FIT_MARGIN * 2) / (box.bottom - box.top),
      )
      onViewport({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, scale: Math.max(scale, 0.01) })
    }
    onFitted()
  }, [fit, size, board.items, onViewport, onFitted])

  // ボード上の点を画面の点に直す
  const toScreen = (x: number, y: number) => ({
    left: size.width / 2 + (x - viewport.x) * viewport.scale,
    top: size.height / 2 + (y - viewport.y) * viewport.scale,
  })

  function down(item: Item, e: React.PointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect([item.id])
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: item.id, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 })
  }

  function move(e: React.PointerEvent) {
    if (drag?.pointer !== e.pointerId) return
    setDrag({ ...drag, dx: e.clientX - drag.startX, dy: e.clientY - drag.startY })
  }

  function up(item: Item, e: React.PointerEvent) {
    if (drag?.pointer !== e.pointerId) return
    setDrag(null)
    if (drag.dx || drag.dy)
      onMove(item.id, item.geometry.x + drag.dx / viewport.scale, item.geometry.y + drag.dy / viewport.scale)
  }

  return (
    <main
      ref={ref}
      className="board__canvas"
      aria-label={`キャンバス：${board.name}`}
      onPointerDown={(e) => e.button === 0 && onSelect([])}
    >
      {board.items.map((item) => {
        const g = item.geometry
        const moving = drag?.id === item.id ? drag : null
        const at = toScreen(g.x, g.y)
        const path = item.source.image_id === null ? undefined : paths[item.source.image_id]
        const status = item.source.status === 'available' ? null : STATUS[item.source.status]
        return (
          <div
            key={item.id}
            className={selected.has(item.id) ? 'board__item board__item--selected' : 'board__item'}
            role="img"
            aria-label={status ? `${item.source.file_name}（${status}）` : item.source.file_name}
            aria-selected={selected.has(item.id)}
            data-id={item.id}
            style={{
              left: at.left + (moving?.dx ?? 0),
              top: at.top + (moving?.dy ?? 0),
              width: g.width * g.scale * viewport.scale,
              height: g.height * g.scale * viewport.scale,
              zIndex: g.stack_order,
              transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
            }}
            onPointerDown={(e) => down(item, e)}
            onPointerMove={move}
            onPointerUp={(e) => up(item, e)}
            onPointerCancel={() => setDrag(null)}
          >
            {status ? (
              <span className="board__status">
                <span>{status}</span>
                <span>{item.source.file_name}</span>
              </span>
            ) : (
              path && (
                <img
                  className="board__image"
                  src={convertFileSrc(path)}
                  alt=""
                  draggable={false}
                  style={{
                    transform: g.flipped ? 'scaleX(-1)' : undefined,
                    filter: g.grayscale ? 'grayscale(1)' : undefined,
                  }}
                />
              )
            )}
          </div>
        )
      })}
    </main>
  )
}

// 配置の外枠。回転と切り抜きは後のタスクで足すので、枠をそのまま使う
function bounds(items: Geometry[]) {
  if (!items.length) return null
  return items.reduce(
    (b, g) => ({
      left: Math.min(b.left, g.x),
      top: Math.min(b.top, g.y),
      right: Math.max(b.right, g.x + g.width * g.scale),
      bottom: Math.max(b.bottom, g.y + g.height * g.scale),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  )
}
