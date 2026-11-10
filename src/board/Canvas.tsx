import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu } from '../contextMenu'
import {
  anchorOf,
  bounds,
  fitView,
  intersects,
  resizeFactor,
  scaleAbout,
  toBoard,
  zoomAt,
  type Box,
  type Corner,
  type Point,
} from './geometry'
import { restack, type Restack } from './stack'
import type { Board, Geometry, Item, Viewport } from './types'

// 状態ごとの枠の文言。元画像がないので、画像やサムネイルの代わりに出す（FR-701）
const STATUS = { trashed: 'ゴミ箱にあります', missing: '見つからない', deleted: '削除された画像' } as const

// 全体が見える表示にするときに、ウィンドウの端から空ける幅
const FIT_MARGIN = 48
// 押した所からこれだけ動くまではクリックとして扱う。クリックの手ぶれで配置が動いて保存されないようにする
const DRAG_START = 3
// 縮小しても、選択枠の長いほうの辺を画面でこれより短くしない。ハンドルをつかめなくなるため
const MIN_SIDE = 16
// ホイールの動き1あたりの倍率の変わり方。ピンチは動きが小さく届くので強くする
const WHEEL_ZOOM = 0.002
const PINCH_ZOOM = 0.01
const WHEEL_MAX = 100
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
// 右クリックのメニューに出す重なり順の操作（FR-702）。ウィンドウの「最前面に固定」とは文言で区別する
const RESTACKS: [Restack, string][] = [
  ['front', '最前面へ'],
  ['forward', '1つ前へ'],
  ['backward', '1つ後ろへ'],
  ['back', '最背面へ'],
]
// 文字の入力、ボタン、ダイアログ、メニューの中。ここでのキーは配置に効かせない（NFR-12）
const NOT_CANVAS = 'input, textarea, select, button, [contenteditable], dialog, [popover]'

// ドラッグ中の操作。同時に1つだけ進む。位置はキャンバスの左上から測った画面の点
type Gesture = { pointer: number; start: Point } & (
  | { kind: 'move'; to: Point; collapse: number | null }
  | { kind: 'marquee'; to: Point; base: number[] }
  | { kind: 'pan'; from: Viewport }
  | { kind: 'resize'; corner: Corner; box: Box; factor: number }
)

// WebKit がトラックパッドのピンチで出すイベント。標準の型にはない
type GestureEvent = Event & { scale: number; clientX?: number; clientY?: number }

// ボードのキャンバス。配置はボード上の座標で持ち、表示の位置と倍率（viewport）で画面の座標に直して描く。
// 選択枠を倍率に関係なく同じ太さで描くため、拡大した層を重ねず1枚ずつ画面の座標に置く
export default function Canvas({
  board,
  paths,
  viewport,
  selected,
  fit,
  locked,
  onViewport,
  onFitted,
  onSelect,
  onGeometry,
  onRemove,
  onUndo,
  onRedo,
  onRestack,
}: {
  board: Board
  // 画像 ID から元画像のパス。読み込むまでは枠だけを出す
  paths: Record<number, string>
  viewport: Viewport
  selected: Set<number>
  // この配置がすべて見える位置と倍率に表示を移す。移したら onFitted を呼ぶ
  fit: number[] | null
  // 編集を受け付けない間は true。操作を始めない
  locked: () => boolean
  // 続けて届くホイールが前の結果に重なるよう、今の表示から次の表示を作る関数で渡す
  onViewport: (update: (viewport: Viewport) => Viewport) => void
  onFitted: () => void
  onSelect: (ids: number[]) => void
  // ドラッグを終えた配置の位置と倍率。変わった配置だけを渡す
  onGeometry: (changed: Map<number, Geometry>) => void
  // 選んだ配置をボードから外す
  onRemove: () => void
  // 配置の変更を取り消す・やり直す
  onUndo: () => void
  onRedo: () => void
  // 選んだ配置の重なり順を変える
  onRestack: (to: Restack) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [space, setSpace] = useState(false)
  // ピンチのイベントに位置がないときに使う、最後のポインターの位置
  const pointer = useRef<Point | null>(null)
  const menu = useContextMenu()

  useLayoutEffect(() => {
    const el = ref.current!
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    // 最初は ResizeObserver の通知を待たずに測る。待つと、それまで大きさ 0 のキャンバスとして配置を置いてしまう
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!fit || !size.width) return
    const box = bounds(board.items.filter((i) => fit.includes(i.id)).map((i) => i.geometry))
    if (box) onViewport(() => fitView(box, size, FIT_MARGIN))
    onFitted()
  }, [fit, size, board.items, onViewport, onFitted])

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ホイールとピンチは、ポインターの位置を中心に拡大・縮小する（FR-703）。
  // React の onWheel は preventDefault できない登録になるので、自分で登録する
  useEffect(() => {
    const el = ref.current!
    const zoom = (at: Point, factor: number) => {
      if (!locked()) onViewport((v) => zoomAt(v, size, at, factor))
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, e.deltaY))
      zoom(local(e), Math.exp(-delta * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM)))
    }
    // scale はピンチを始めてからの倍率なので、前の値との比を使う
    let last = 1
    const pinch = (e: Event) => {
      e.preventDefault()
      const g = e as GestureEvent
      if (e.type === 'gesturestart') last = 1
      const at =
        g.clientX === undefined || g.clientY === undefined
          ? (pointer.current ?? { x: size.width / 2, y: size.height / 2 })
          : local({ clientX: g.clientX, clientY: g.clientY })
      zoom(at, g.scale / last)
      last = g.scale
    }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('gesturestart', pinch)
    el.addEventListener('gesturechange', pinch)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('gesturestart', pinch)
      el.removeEventListener('gesturechange', pinch)
    }
  }, [size, locked, onViewport])

  // キャンバスのキー操作。コールバックは描くたびに変わるので、登録し直さずに最新のものを呼ぶ
  const keys = useRef({ board, selected, gesture, locked, onSelect, onRemove, onUndo, onRedo })
  keys.current = { board, selected, gesture, locked, onSelect, onRemove, onUndo, onRedo }
  useEffect(() => {
    const outside = (e: KeyboardEvent) =>
      (e.target instanceof Element && e.target.closest(NOT_CANVAS) !== null) ||
      document.querySelector('dialog[open], :popover-open') !== null
    const down = (e: KeyboardEvent) => {
      if (outside(e)) return
      const k = keys.current
      const select = e.key === 'a' && e.metaKey && !e.shiftKey && !e.altKey
      // ⇧ を押していると、キーの文字は大文字で届くことがある
      const undo = e.key.toLowerCase() === 'z' && e.metaKey && !e.altKey
      // Mac の delete キーは Backspace として届く
      const remove = e.key === 'Delete' || e.key === 'Backspace'
      if (e.code !== 'Space' && !select && !undo && !remove) return
      // 何もしないと、Space はスクロール、⌘A はウィンドウの文字の全選択、Backspace は前のページへ戻る操作、
      // ⌘Z は前に使った入力欄の文字の取り消しになる。編集を受け付けない間も止める
      e.preventDefault()
      if (e.code === 'Space') setSpace(true)
      else if (k.locked()) return
      else if (select) k.onSelect(k.board.items.map((i) => i.id))
      // ドラッグの途中では取り消さない。ドラッグは、始めたときの配置を元に終わるため
      else if (undo) {
        if (!k.gesture) (e.shiftKey ? k.onRedo : k.onUndo)()
      } else if (k.selected.size) k.onRemove()
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    // ほかのウィンドウで Space を離すと keyup が届かない
    const blur = () => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // ボード上の点を画面の点に直す
  const toScreen = (x: number, y: number) => ({
    left: size.width / 2 + (x - viewport.x) * viewport.scale,
    top: size.height / 2 + (y - viewport.y) * viewport.scale,
  })

  // ドラッグ中の配置は、終えたときの位置と倍率で描く
  const chosen = board.items.filter((i) => selected.has(i.id))
  function live(item: Item): Geometry {
    const g = item.geometry
    if (!gesture || !selected.has(item.id)) return g
    if (gesture.kind === 'move')
      return {
        ...g,
        x: g.x + (gesture.to.x - gesture.start.x) / viewport.scale,
        y: g.y + (gesture.to.y - gesture.start.y) / viewport.scale,
      }
    if (gesture.kind === 'resize') return scaleAbout(g, anchorOf(gesture.box, gesture.corner), gesture.factor)
    return g
  }

  // 操作は押した所で決まる。Space か中ボタンならパン、ハンドルなら拡大・縮小、配置なら選択と移動、空白なら範囲選択。
  // パンを先に見るので、配置の上や空白から始めても、移動や範囲選択にはならない（FR-702、FR-703）
  function down(e: React.PointerEvent<HTMLElement>) {
    if (gesture || locked()) return
    // control＋クリックは右クリックとして届く。メニューを出すだけにして、選択をまとめ直したり動かしたりしない
    if (e.ctrlKey && e.button === 0) return
    const pan = e.button === 1 || (e.button === 0 && space)
    if (!pan && e.button !== 0) return
    const target = e.target as Element
    const base = { pointer: e.pointerId, start: local(e) }
    const begin = (g: Gesture) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      setGesture(g)
    }
    if (pan) return begin({ ...base, kind: 'pan', from: viewport })

    const corner = target.closest<HTMLElement>('[data-corner]')?.dataset.corner as Corner | undefined
    const box = bounds(chosen.map((i) => i.geometry))
    if (corner && box) return begin({ ...base, kind: 'resize', corner, box, factor: 1 })

    const add = e.metaKey || e.shiftKey
    const hit = target.closest<HTMLElement>('[data-id]')
    if (!hit) {
      const kept = add ? [...selected] : []
      onSelect(kept)
      return begin({ ...base, kind: 'marquee', to: base.start, base: kept })
    }
    const id = Number(hit.dataset.id)
    const was = selected.has(id)
    if (add && was) return onSelect([...selected].filter((s) => s !== id))
    if (add) onSelect([...selected, id])
    else if (!was) onSelect([id])
    // 複数を選んだうちの1枚を押したときは、動かすかもしれないので選択を残す。動かさずに離したらその1枚だけにする
    begin({ ...base, kind: 'move', to: base.start, collapse: !add && was && selected.size > 1 ? id : null })
  }

  function move(e: React.PointerEvent<HTMLElement>) {
    const at = local(e)
    pointer.current = at
    if (gesture?.pointer !== e.pointerId) return
    const dx = at.x - gesture.start.x
    const dy = at.y - gesture.start.y
    if (gesture.kind === 'pan') {
      const { from } = gesture
      onViewport(() => ({ ...from, x: from.x - dx / from.scale, y: from.y - dy / from.scale }))
    } else if (gesture.kind === 'resize') {
      const longer = Math.max(gesture.box.right - gesture.box.left, gesture.box.bottom - gesture.box.top)
      const min = MIN_SIDE / (longer * viewport.scale)
      setGesture({
        ...gesture,
        factor: resizeFactor(gesture.box, gesture.corner, toBoard(viewport, size, at), Math.min(min, 1)),
      })
    } else if (gesture.to !== gesture.start || Math.hypot(dx, dy) >= DRAG_START) {
      setGesture({ ...gesture, to: at })
      if (gesture.kind === 'marquee') {
        const a = toBoard(viewport, size, gesture.start)
        const b = toBoard(viewport, size, at)
        const box = {
          left: Math.min(a.x, b.x),
          top: Math.min(a.y, b.y),
          right: Math.max(a.x, b.x),
          bottom: Math.max(a.y, b.y),
        }
        const hits = board.items.filter((i) => intersects(box, i.geometry)).map((i) => i.id)
        onSelect([...new Set([...gesture.base, ...hits])])
      }
    }
  }

  function up(e: React.PointerEvent<HTMLElement>, cancelled = false) {
    if (gesture?.pointer !== e.pointerId) return
    setGesture(null)
    if (cancelled) return
    const changed =
      (gesture.kind === 'move' && gesture.to !== gesture.start) || (gesture.kind === 'resize' && gesture.factor !== 1)
    if (changed) onGeometry(new Map(chosen.map((i) => [i.id, live(i)])))
    else if (gesture.kind === 'move' && gesture.collapse !== null) onSelect([gesture.collapse])
  }

  function context(e: React.MouseEvent) {
    const hit = (e.target as Element).closest<HTMLElement>('[data-id]')
    if (!hit) return
    e.preventDefault()
    if (gesture || locked()) return
    // 右クリックした配置を選んでいなければ、その配置だけを選ぶ（ギャラリーと同じ）
    const id = Number(hit.dataset.id)
    if (!selected.has(id)) onSelect([id])
    menu.setAt({ x: e.clientX, y: e.clientY })
  }

  const frame = bounds(chosen.map(live))
  const frameAt = frame && toScreen(frame.left, frame.top)
  const classes = ['board__canvas']
  if (space || gesture?.kind === 'pan') classes.push('board__canvas--pan')

  return (
    <>
      <main
        ref={ref}
        className={classes.join(' ')}
        aria-label={`キャンバス：${board.name}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => up(e)}
        onPointerCancel={(e) => up(e, true)}
        onContextMenu={context}
      >
        <div className="board__items">
          {board.items.map((item) => {
            const g = live(item)
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
                  left: at.left,
                  top: at.top,
                  width: g.width * g.scale * viewport.scale,
                  height: g.height * g.scale * viewport.scale,
                  zIndex: g.stack_order,
                  transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
                }}
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
        </div>
        {frame && frameAt && (
          <div
            className={chosen.length > 1 ? 'board__frame board__frame--group' : 'board__frame'}
            style={{
              ...frameAt,
              width: (frame.right - frame.left) * viewport.scale,
              height: (frame.bottom - frame.top) * viewport.scale,
            }}
          >
            {CORNERS.map((c) => (
              <span key={c} className={`board__handle board__handle--${c}`} data-corner={c} />
            ))}
          </div>
        )}
        {gesture?.kind === 'marquee' && gesture.to !== gesture.start && (
          <div
            className="board__marquee"
            style={{
              left: Math.min(gesture.start.x, gesture.to.x),
              top: Math.min(gesture.start.y, gesture.to.y),
              width: Math.abs(gesture.to.x - gesture.start.x),
              height: Math.abs(gesture.to.y - gesture.start.y),
            }}
          />
        )}
      </main>
      {/* キャンバスの外に置く。中に置くと、メニューを押したことが空白を押した範囲選択の始まりになる */}
      {menu.at && (
        <div ref={menu.ref} className="menu" role="menu" popover="manual" style={{ top: menu.at.y, left: menu.at.x }}>
          {RESTACKS.map(([to, label]) => (
            <button
              key={to}
              type="button"
              role="menuitem"
              className="menu__item"
              disabled={!restack(board.items, selected, to)}
              onClick={() => {
                menu.setAt(null)
                onRestack(to)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
