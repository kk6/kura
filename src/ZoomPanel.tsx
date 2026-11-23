import type { Image } from './galleryTypes'
import { Icon, ICONS } from './icons'
import { poseBox, skeleton } from './pose'
import { type Zoom, ZOOM_STEP } from './useZoom'
import { scaleOf, type Size, zoomRange } from './zoomView'
import './ZoomPanel.css'

type Props = {
  zoom: Zoom
  image: Image
  // 画像のファイルの URL
  src: string
  // 前後の画像へ移る。端の画像では渡さず、< > を出さない
  onPrev?: () => void
  onNext?: () => void
  // 右クリック。一覧と同じメニューを出す（FR-515）
  onContextMenu: (e: React.MouseEvent) => void
  // 重ねる骨格（FR-606）。人物ごとに [x, y, スコア] × 17。重ねないときは空
  people: number[][]
}

// 拡大表示（FR-508）。一覧と同じ場所に重ねて出す
export default function ZoomPanel({ zoom, image, src, onPrev, onNext, onContextMenu, people }: Props) {
  const { view, frame } = zoom
  // 枠を測った後の画像の置き方。骨格も同じ場所に重ねる
  const placed = frame && {
    // 枠の中央から view の分ずらし、倍率の大きさで描く。transform の拡大ではぼけるので幅で描く
    position: 'absolute' as const,
    top: '50%',
    left: '50%',
    width: image.width * scaleOf(view, image, frame),
    transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
  }
  return (
    <section
      {...zoom.section}
      onContextMenu={onContextMenu}
      className={
        'gallery__zoom' +
        // 枠からはみ出していて動かせるときだけ、つかめる形のカーソルにする
        (frame &&
        (image.width * scaleOf(view, image, frame) > frame.width ||
          image.height * scaleOf(view, image, frame) > frame.height)
          ? ' gallery__zoom--movable'
          : '')
      }
      aria-label="拡大表示"
    >
      <img
        className="zoom__image"
        src={src}
        alt={image.file_name}
        draggable={false}
        style={{
          aspectRatio: `${image.width} / ${image.height}`,
          background: image.color,
          ...(placed ||
            // 枠を測るまでは、小さい画像も枠いっぱいに広げ、縦横比を保ったまま収める
            { width: `min(100cqw, calc(100cqh * ${image.width / image.height}))` }),
        }}
      />
      {placed && people.length > 0 && <Skeleton people={people} image={image} style={placed} />}
      {onPrev && (
        <button type="button" className="zoom__nav zoom__nav--prev" aria-label="前の画像" onClick={onPrev}>
          <span className="zoom__arrow">
            <Chevron d="M15 6l-6 6 6 6" />
          </span>
        </button>
      )}
      {onNext && (
        <button type="button" className="zoom__nav zoom__nav--next" aria-label="次の画像" onClick={onNext}>
          <span className="zoom__arrow">
            <Chevron d="M9 6l6 6-6 6" />
          </span>
        </button>
      )}
    </section>
  )
}

// ツールバーに出す画像の倍率。拡大表示の間、サムネイルの大きさのスライダーの代わりに出す
export function ZoomSlider({ zoom, image, frame }: { zoom: Zoom; image: Size; frame: Size }) {
  const { view, zoomBy } = zoom
  const range = zoomRange(image, frame)
  const scale = scaleOf(view, image, frame)
  const toScale = (zoom: number) => scaleOf({ ...view, zoom }, image, frame)
  return (
    <span className="toolbar__size">
      <button
        type="button"
        className="toolbar__step"
        aria-label="縮小"
        title="縮小（⌘−）"
        disabled={view.zoom <= range.min}
        onClick={() => zoomBy(1 / ZOOM_STEP)}
      >
        <Icon d={ICONS.zoomOut} />
      </button>
      {/* 倍率は掛け算で変わるので、つまみの位置は倍率の対数にする */}
      <input
        className="slider"
        type="range"
        aria-label="画像の倍率"
        aria-valuetext={`${Math.round(scale * 100)}%`}
        min={Math.log2(toScale(range.min))}
        max={Math.log2(toScale(range.max))}
        step={0.01}
        value={Math.log2(scale)}
        onChange={(e) => zoomBy(2 ** Number(e.target.value) / scale)}
      />
      <button
        type="button"
        className="toolbar__step"
        aria-label="拡大"
        title="拡大（⌘＋）"
        disabled={view.zoom >= range.max}
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        <Icon d={ICONS.zoomIn} />
      </button>
      <span className="toolbar__zoom-value">{Math.round(scale * 100)}%</span>
    </span>
  )
}

const Chevron = ({ d }: { d: string }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
)

// 骨格を画像と同じ場所に重ねる。viewBox を関節の座標の入れ物にし、線の太さは倍率によらず同じにする
function Skeleton({ people, image, style }: { people: number[][]; image: Size; style: React.CSSProperties }) {
  const box = poseBox(image)
  const { lines, joints } = skeleton(people)
  const bones = lines.map(([a, b]) => `M${a.x} ${a.y}L${b.x} ${b.y}`).join('')
  // 長さ0の線を丸い端で描くと、太さの直径の点になる
  const dots = joints.map((p) => `M${p.x} ${p.y}h0`).join('')
  return (
    <svg
      className="zoom__pose"
      viewBox={`0 0 ${box.width} ${box.height}`}
      style={{ ...style, aspectRatio: `${image.width} / ${image.height}` }}
      aria-hidden="true"
    >
      {/* 黒い縁を下に敷き、上に白を重ねる。明るい写真にも暗い写真にも見えるように */}
      <path className="zoom__pose-edge" d={bones} />
      <path className="zoom__pose-edge zoom__pose-joint" d={dots} />
      <path className="zoom__pose-line" d={bones} />
      <path className="zoom__pose-line zoom__pose-joint" d={dots} />
    </svg>
  )
}
