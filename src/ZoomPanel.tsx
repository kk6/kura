import type { Image } from './galleryTypes'
import { Icon, ICONS } from './icons'
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
  onClose: () => void
}

// 拡大表示（FR-508）。一覧と同じ場所に重ねて出す
export default function ZoomPanel({ zoom, image, src, onPrev, onNext, onClose }: Props) {
  const { view, frame } = zoom
  return (
    <section
      {...zoom.section}
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
          ...(frame
            ? {
                // 枠の中央から view の分ずらし、倍率の大きさで描く。transform の拡大ではぼけるので幅で描く
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: image.width * scaleOf(view, image, frame),
                transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
              }
            : // 枠を測るまでは、小さい画像も枠いっぱいに広げ、縦横比を保ったまま収める
              { width: `min(100cqw, calc(100cqh * ${image.width / image.height}))` }),
        }}
      />
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
      <button type="button" className="button zoom__close" onClick={onClose}>
        閉じる
      </button>
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
