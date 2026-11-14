import { type MouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { FIT, panView, type Size, type View, zoomViewAt } from './zoomView'

// 拡大表示の ⌘＋、⌘−、虫眼鏡のボタンで変える倍率
export const ZOOM_STEP = 1.25
// ホイールのピンチ（ctrlKey 付き）の deltaY 1あたりの倍率の変わり方
const PINCH_ZOOM = 0.01
// 押してからドラッグとみなす動きの距離（px）。< > のボタンのクリックと区別する
const PAN_START = 4

// 拡大表示（FR-508）の中の倍率と位置。zoomed は拡大している画像で、拡大していなければ null。
// 倍率はツールバーのスライダーとキーボードからも変えるので、表示（ZoomPanel）の外で持つ
export function useZoom(zoomed: ({ id: number } & Size) | null) {
  // 拡大表示の中の倍率と位置。画像の id ごとに持ち、前後の画像へ移ると枠に合わせた大きさ（FIT）に戻る
  const [zoomView, setZoomView] = useState<{ id: number; view: View } | null>(null)
  // 拡大表示の枠（余白を除いた大きさ）。測るまでは null で、CSS だけで枠に合わせる
  const [frame, setFrame] = useState<Size | null>(null)
  const zoomRef = useRef<HTMLElement>(null)

  const view = zoomed && zoomView?.id === zoomed.id ? zoomView.view : FIT
  // 倍率と位置を変える。イベントのリスナーから呼んでも古い値を使わないよう、前の値から計算する
  const changeView = (edit: (v: View, image: Size, frame: Size) => View) => {
    if (!zoomed || !frame) return
    const { id, width, height } = zoomed
    setZoomView((z) => ({ id, view: edit(z?.id === id ? z.view : FIT, { width, height }, frame) }))
  }
  const zoomBy = (factor: number) => changeView((v, i, f) => zoomViewAt(v, i, f, { x: 0, y: 0 }, factor))
  const changeViewRef = useRef(changeView)
  changeViewRef.current = changeView

  // 枠の大きさを測る。ウィンドウや詳細パネルの開閉で変わる
  const zoomOpen = zoomed !== null
  useEffect(() => {
    const el = zoomRef.current
    if (!el) return setFrame(null)
    const observer = new ResizeObserver(([entry]) =>
      setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [zoomOpen])

  // ピンチ（Safari の gesture と、ctrlKey 付きのホイール）はポインターの位置を中心に拡大・縮小し、
  // 2本指のスクロールは表示を動かす（プレビューと同じ）。React の onWheel は preventDefault できないので自分で登録する
  useEffect(() => {
    const el = zoomRef.current
    if (!el) return
    const fromCenter = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const at = fromCenter(e.clientX, e.clientY)
      if (e.ctrlKey) changeViewRef.current((v, i, f) => zoomViewAt(v, i, f, at, Math.exp(-e.deltaY * PINCH_ZOOM)))
      else changeViewRef.current((v, i, f) => panView(v, i, f, -e.deltaX, -e.deltaY))
    }
    // scale はピンチを始めてからの倍率なので、前の値との比を使う
    let last = 1
    const pinch = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      if (e.type === 'gesturestart') last = 1
      const at = fromCenter(g.clientX, g.clientY)
      const factor = g.scale / last
      last = g.scale
      changeViewRef.current((v, i, f) => zoomViewAt(v, i, f, at, factor))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('gesturestart', pinch)
    el.addEventListener('gesturechange', pinch)
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('gesturestart', pinch)
      el.removeEventListener('gesturechange', pinch)
    }
  }, [zoomOpen])

  // ドラッグで表示を動かす。PAN_START 以上動いたらドラッグとみなし、離した後のクリックを止める
  // （< > のボタンの上から始めても、前後の画像へ移らないように）
  const pan = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const [panning, setPanning] = useState(false)
  useEffect(() => {
    if (!panning) return
    const move = (e: PointerEvent) => {
      const p = pan.current!
      const dx = e.clientX - p.x
      const dy = e.clientY - p.y
      if (!p.moved && Math.hypot(dx, dy) < PAN_START) return
      p.moved = true
      p.x = e.clientX
      p.y = e.clientY
      changeViewRef.current((v, i, f) => panView(v, i, f, dx, dy))
    }
    const up = () => setPanning(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [panning])

  return {
    view,
    frame,
    changeView,
    zoomBy,
    // 拡大表示の枠の要素に渡す
    section: {
      ref: zoomRef,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button !== 0) return
        pan.current = { x: e.clientX, y: e.clientY, moved: false }
        setPanning(true)
      },
      onClickCapture: (e: MouseEvent) => {
        if (!pan.current?.moved) return
        pan.current = null
        e.stopPropagation()
        e.preventDefault()
      },
    },
  }
}

export type Zoom = ReturnType<typeof useZoom>
