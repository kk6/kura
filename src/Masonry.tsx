import { Icon, ICONS } from './icons'
import { convertFileSrc } from '@tauri-apps/api/core'
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Image } from './galleryTypes'
import { type Arrow, layout, neighbor, visible, within } from './layout'
import { enclose, type Selection } from './selection'
import './Masonry.css'

type Props = {
  root: string
  images: Image[]
  // 変わったときだけスクロールを先頭に戻す。並べ替え・絞り込み・一覧の切り替えで変える。
  // images で戻すと、タグやメモを変えただけで先頭に戻ってしまう
  scrollKey: unknown
  // scrollKey が変わったときに移るスクロールの位置。なければ先頭。類似画像検索を閉じて元の一覧に戻すときに使う
  scrollTo?: number
  // スクロールした位置を知らせる。1フレームに1回まで
  onScrolled?: (top: number) => void
  // 1枚もないときに出す文言
  empty: string
  thumbWidth: number
  // 一覧を区切る見出しの行（元が同じ画像の組。FR-611）。start は区切りの後の最初の画像の番号
  sections?: { start: number; header: ReactNode }[]
  selected: Set<number>
  // id が null のときは画像のない所を押した
  onSelect: (id: number | null, e: MouseEvent) => void
  // 画像のない所からのドラッグで囲んだ選択（FR-512）。離したときに呼ぶ
  onEnclose: (selection: Selection) => void
  onOpen: () => void
  // 画像の右クリック。なければ WebView の初期のメニューを出す
  onContextMenu?: (id: number, e: MouseEvent) => void
  // 画像をドラッグし始めた（FR-713）。運ぶ画像を決めるのは呼ぶ側
  onDragStart?: (id: number, e: React.DragEvent) => void
  // 矢印キーで選択を動かす（NFR-12）。active は動かす元の画像。keys が false の間（拡大表示中など）は受けない
  active: number | null
  // この画像が見える所までスクロールする。同じ画像でももう一度スクロールできるよう、毎回新しいオブジェクトで受ける
  reveal: { id: number } | null
  keys: boolean
  onMove: (id: number) => void
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
// 範囲選択とみなす動きの距離（px）。クリックで選択を外すのと区別する
const DRAG_START = 4

type Point = { x: number; y: number }

export default function Masonry({
  root,
  images,
  scrollKey,
  scrollTo,
  onScrolled,
  empty,
  thumbWidth,
  sections,
  selected,
  onSelect,
  onEnclose,
  onContextMenu,
  onDragStart,
  onOpen,
  active,
  reveal,
  keys,
  onMove,
}: Props) {
  const ref = useRef<HTMLElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0, gap: 0, header: 0 })

  useEffect(() => {
    const el = ref.current!
    const measure = () =>
      setViewport({
        width: el.clientWidth,
        height: el.clientHeight,
        // 配置の計算に数値が要るので、サムネイルの間隔のトークンを読む
        gap: parseFloat(getComputedStyle(el).getPropertyValue('--space-2')),
        // 区切りの見出しの行は、一覧の上の帯と同じ高さ（docs/design.md）
        header: parseFloat(getComputedStyle(el).getPropertyValue('--size-toolbar')),
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    ref.current!.scrollTop = scrollTo ?? 0
    // scrollTo だけが変わっても動かさない。利用者がスクロールした位置を戻さないため
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  const { width, height, gap, header } = viewport
  const starts = useMemo(() => sections?.map((s) => s.start), [sections])
  const l = useMemo(
    () => (width ? layout(images, width - gap * 2, thumbWidth, gap, starts && { starts, header }) : undefined),
    [images, width, gap, thumbWidth, starts, header],
  )

  // 「ギャラリーで表示」の画像が見える所までスクロールする。選ぶと詳細パネルが開いて幅が変わり、並べ直しで
  // 位置がずれるので、利用者が次に操作するまでは並べ直しのたびに合わせ直す
  const following = useRef<{ id: number } | null>(null)
  useEffect(() => {
    following.current = reveal
    if (!reveal) return
    const stop = () => (following.current = null)
    const inputs = ['pointerdown', 'keydown', 'wheel'] as const
    inputs.forEach((type) => window.addEventListener(type, stop, true))
    return () => inputs.forEach((type) => window.removeEventListener(type, stop, true))
  }, [reveal])
  // 上の「先頭に戻す」より後に流す。絞り込みを外すのと同時に頼まれると、一覧も同じ描画で変わるため
  useEffect(() => {
    const id = following.current?.id
    const at = id === undefined ? -1 : images.findIndex((i) => i.id === id)
    if (at < 0 || !l) return
    ref.current!.scrollTop = Math.max(0, l.y[at] + gap - (height - l.h[at]) / 2)
  }, [reveal, l, images, gap, height])

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

  // 範囲選択（FR-512）。from は押した位置（配置の座標）、to は今のポインターの画面の位置。
  // 囲む画像は描いている画像ではなく配置から求めるので、ドラッグ中にスクロールしても画面の外の画像まで選べる
  const press = useRef<{ from: Point; to: Point; base: Selection; additive: boolean; moved: boolean } | null>(null)
  const [band, setBand] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null)
  // ドラッグ中の選択。一覧の中だけで描き、離したときに onEnclose で確定する。
  // 毎フレーム確定すると、2万枚で数千枚を囲んだときに詳細パネルまで描き直し、フレームを落とすため（NFR-01）
  const [live, setLive] = useState<Selection | null>(null)
  const shownSelected = live?.ids ?? selected
  // 範囲選択の後のクリックで、選んだばかりの選択を外さない
  const enclosed = useRef(false)
  const frame = useRef(0)
  const toLayout = (client: Point): Point => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    return { x: client.x - r.left + el.scrollLeft - gap, y: client.y - r.top + el.scrollTop - gap }
  }
  const apply = () => {
    const p = press.current
    if (!p || !l) return
    const to = toLayout(p.to)
    const rect = {
      left: Math.min(p.from.x, to.x),
      top: Math.min(p.from.y, to.y),
      right: Math.max(p.from.x, to.x),
      bottom: Math.max(p.from.y, to.y),
    }
    const next = enclose(
      p.base,
      within(l, rect).map((i) => images[i].id),
      p.additive,
    )
    setBand(rect)
    setLive(next)
    return next
  }
  // ポインターの動きとスクロールのたびに呼ぶ。選び直すのは1フレームに1回まで（NFR-01）
  const stretch = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      apply()
    })
  }
  const endBand = () => {
    press.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    setBand(null)
    setLive(null)
  }

  // スクロールのたびに描き直さず、1フレームに1回だけ反映する
  const onScroll = () => {
    const el = ref.current!
    if (press.current?.moved) stretch()
    requestAnimationFrame(() => {
      setScrollTop(el.scrollTop)
      onScrolled?.(el.scrollTop)
    })
  }

  // 表示範囲の上下に1画面分ずつ余分に描いておく
  const shown = l ? visible(l, scrollTop - gap - height, scrollTop - gap + height * 2) : []

  return (
    <main
      ref={ref}
      className="gallery__list"
      aria-label="画像の一覧"
      onScroll={onScroll}
      onPointerDown={(e) => {
        const el = ref.current!
        const target = e.target as HTMLElement
        // 画像の上から押したら画像を運ぶ（FR-713、FR-514）。見出しの行とスクロールバーの上からは始めない
        if (e.button !== 0 || e.ctrlKey || target.dataset.id || target.closest('.list__section') || !l) return
        if (e.clientX - el.getBoundingClientRect().left >= el.clientWidth) return
        const at = { x: e.clientX, y: e.clientY }
        press.current = {
          from: toLayout(at),
          to: at,
          base: { ids: selected, anchor: active },
          additive: e.metaKey || e.shiftKey,
          moved: false,
        }
        // 一覧の外まで動かしても受け続ける
        el.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const p = press.current
        if (!p) return
        p.to = { x: e.clientX, y: e.clientY }
        const to = toLayout(p.to)
        p.moved ||= Math.hypot(to.x - p.from.x, to.y - p.from.y) >= DRAG_START
        if (p.moved) stretch()
      }}
      onPointerUp={() => {
        // 次のフレームを待たずに、離した位置で選び直す
        enclosed.current = !!press.current?.moved
        const last = enclosed.current && apply()
        endBand()
        if (last) onEnclose(last)
      }}
      onPointerCancel={endBand}
      onClick={(e) => {
        if (enclosed.current) return void (enclosed.current = false)
        const id = (e.target as HTMLElement).dataset.id
        onSelect(id ? Number(id) : null, e)
      }}
      // 1回目のクリックでその画像だけが選ばれている
      onContextMenu={(e) => {
        const id = (e.target as HTMLElement).dataset.id
        if (id && onContextMenu) onContextMenu(Number(id), e)
      }}
      onDragStart={(e) => {
        const id = (e.target as HTMLElement).dataset.id
        if (id && onDragStart) onDragStart(Number(id), e)
      }}
      onDoubleClick={(e) => (e.target as HTMLElement).dataset.id && !e.shiftKey && !e.metaKey && onOpen()}
    >
      {images.length === 0 ? (
        <p className="list__empty">{empty}</p>
      ) : (
        l && (
          <div className="list__canvas" style={{ height: l.height + gap * 2 }}>
            {sections?.map(
              (section, k) =>
                // 見出しは組の数だけなので、見える範囲の上下1画面分だけ描く
                Math.abs(l.headers[k] - scrollTop) < height * 2 && (
                  <div
                    key={section.start}
                    className={k ? 'list__section' : 'list__section list__section--first'}
                    style={{ width: width - gap * 2, transform: `translate(${gap}px, ${l.headers[k] + gap}px)` }}
                    // 見出しの中を押しても、画像のない所を押したとして選択を外さない
                    onClick={(e) => e.stopPropagation()}
                  >
                    {section.header}
                  </div>
                ),
            )}
            {band && (
              <div
                className="list__band"
                style={{
                  width: band.right - band.left,
                  height: band.bottom - band.top,
                  transform: `translate(${band.left + gap}px, ${band.top + gap}px)`,
                }}
              />
            )}
            {shown.map((i) => [
              <img
                key={images[i].id}
                className={shownSelected.has(images[i].id) ? 'list__thumb list__thumb--selected' : 'list__thumb'}
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
              shownSelected.has(images[i].id) && (
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
