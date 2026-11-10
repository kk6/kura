import { describe, expect, it } from 'vitest'
import {
  bounds,
  centerOf,
  cropOf,
  fitView,
  intersects,
  pinned,
  resizeFactor,
  scaleAbout,
  snap,
  toBoard,
  turned,
  zoomAt,
  MAX_ZOOM,
  MIN_ZOOM,
} from './geometry'
import type { Geometry } from './types'

const g = (x: number, y: number, width: number, height: number, scale = 1): Geometry => ({
  width,
  height,
  x,
  y,
  scale,
  rotation: 0,
  flipped: false,
  grayscale: false,
  crop: null,
  stack_order: 0,
})

const size = { width: 800, height: 600 }

describe('bounds', () => {
  it('倍率をかけた枠をすべて囲む', () => {
    expect(bounds([g(0, 0, 100, 50), g(200, -20, 100, 100, 0.5)])).toEqual({
      left: 0,
      top: -20,
      right: 250,
      bottom: 50,
    })
  })
  it('配置がなければ null', () => {
    expect(bounds([])).toBeNull()
  })
})

describe('fitView', () => {
  it('余白を空けて、枠の全体が入る倍率と中央にする', () => {
    const v = fitView({ left: 1000, top: 1000, right: 1400, bottom: 1100 }, size, 50)
    expect(v).toEqual({ x: 1200, y: 1050, scale: 700 / 400 })
  })
  it('ウィンドウが余白より狭くても、倍率を正の値にする', () => {
    expect(fitView({ left: 0, top: 0, right: 10, bottom: 10 }, { width: 20, height: 20 }, 50).scale).toBe(MIN_ZOOM)
  })
})

describe('zoomAt', () => {
  it('ポインターの下のボード上の点を動かさずに倍率を変える', () => {
    const v = { x: 30, y: -40, scale: 0.5 }
    const point = { x: 650, y: 120 }
    const zoomed = zoomAt(v, size, point, 3)
    expect(zoomed.scale).toBe(1.5)
    const before = toBoard(v, size, point)
    const after = toBoard(zoomed, size, point)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })
  it('倍率を上限と下限で止める', () => {
    const v = { x: 0, y: 0, scale: 1 }
    expect(zoomAt(v, size, { x: 0, y: 0 }, 1e9).scale).toBe(MAX_ZOOM)
    expect(zoomAt(v, size, { x: 0, y: 0 }, 1e-9).scale).toBe(MIN_ZOOM)
  })
})

describe('resizeFactor', () => {
  const box = { left: 0, top: 0, right: 200, bottom: 100 }
  it('向かいの角を基準に、ポインターが遠いほうの軸で倍率を決める', () => {
    expect(resizeFactor(box, 'se', { x: 400, y: 120 }, 0.1)).toBe(2)
    expect(resizeFactor(box, 'nw', { x: 100, y: 0 }, 0.1)).toBe(1)
    expect(resizeFactor(box, 'nw', { x: 100, y: 50 }, 0.1)).toBe(0.5)
  })
  it('向かいの角を越えて引いても、下限より小さくしない', () => {
    expect(resizeFactor(box, 'se', { x: -50, y: -50 }, 0.1)).toBe(0.1)
  })
})

describe('scaleAbout', () => {
  it('基準の点からの距離と倍率に同じ値をかけ、枠の寸法は変えない', () => {
    const scaled = scaleAbout(g(110, 20, 300, 200, 0.5), { x: 10, y: 0 }, 2)
    expect(scaled).toMatchObject({ x: 210, y: 40, scale: 1, width: 300, height: 200 })
  })
})

describe('intersects', () => {
  const box = { left: 0, top: 0, right: 100, bottom: 100 }
  it('少しでも重なれば true、離れていれば false', () => {
    expect(intersects(box, g(90, 90, 50, 50))).toBe(true)
    expect(intersects(box, g(101, 0, 50, 50))).toBe(false)
    expect(intersects(box, g(-100, 0, 400, 100, 0.2))).toBe(false)
  })
})

const close = (actual: object | null, expected: Record<string, number>) =>
  Object.entries(expected).forEach(([k, v]) => expect((actual as Record<string, number>)[k], k).toBeCloseTo(v))
const right = { x: 0.5, y: 0, width: 0.5, height: 1 }

describe('回転・反転・切り抜きをした配置の外枠', () => {
  it('回転は枠の中心で回し、回した後の四隅を囲む', () => {
    close(bounds([{ ...g(0, 0, 100, 50), rotation: 90 }]), { left: 25, top: -25, right: 75, bottom: 75 })
    const half = 50 * Math.SQRT2
    close(bounds([{ ...g(0, 0, 100, 100), rotation: 45 }]), {
      left: 50 - half,
      top: 50 - half,
      right: 50 + half,
      bottom: 50 + half,
    })
  })
  it('切り抜いた配置は、描く範囲だけを囲む。反転していれば左右が入れ替わる', () => {
    close(bounds([{ ...g(0, 0, 100, 50), crop: right }]), { left: 50, top: 0, right: 100, bottom: 50 })
    close(bounds([{ ...g(0, 0, 100, 50), crop: right, flipped: true }]), { left: 0, top: 0, right: 50, bottom: 50 })
    close(bounds([{ ...g(0, 0, 100, 50, 2), crop: right, rotation: 180 }]), {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
    })
  })
})

describe('intersects（回転した配置）', () => {
  const diamond = { ...g(0, 0, 100, 100), rotation: 45 }
  it('回した後の外枠の角にあるだけの、画像のない所とは重ならない', () => {
    expect(intersects({ left: -20, top: -20, right: -5, bottom: -5 }, diamond)).toBe(false)
    expect(intersects({ left: -20, top: 40, right: -5, bottom: 60 }, diamond)).toBe(true)
    expect(intersects({ left: 40, top: 40, right: 60, bottom: 60 }, diamond)).toBe(true)
  })
  it('切り抜いて描いていない所とは重ならない', () => {
    expect(intersects({ left: 0, top: 0, right: 40, bottom: 50 }, { ...g(0, 0, 100, 50), crop: right })).toBe(false)
  })
})

describe('pinned と turned', () => {
  const cropped = { ...g(10, 20, 200, 100), crop: right }
  it('回転を変えても、描く範囲の中心は動かない', () => {
    const next = turned(cropped, 90)
    expect(next.rotation).toBe(90)
    close(centerOf(next), centerOf(cropped))
    close(centerOf(turned(next, 0)), centerOf(cropped))
  })
  it('角度は 0 以上 360 未満にそろえる', () => {
    expect(turned(cropped, -90).rotation).toBe(270)
    expect(turned(cropped, 720).rotation).toBe(0)
  })
  it('反転しても、描く範囲の中心は動かない', () => {
    const rotated = turned(cropped, 30)
    close(centerOf(pinned(rotated, { ...rotated, flipped: true })), centerOf(rotated))
  })
  it('切り抜いていなければ、枠は動かない', () => {
    expect(turned(g(10, 20, 200, 100), 45)).toMatchObject({ x: 10, y: 20 })
  })
})

describe('snap', () => {
  it('15度刻みの近いほうにそろえる', () => {
    expect(snap(52)).toBe(45)
    expect(snap(53)).toBe(60)
    expect(snap(-8)).toBe(-15)
  })
})

describe('cropOf', () => {
  const wide = g(0, 0, 200, 100)
  it('ボード上の2点を、元画像に対する 0〜1 の四角にする', () => {
    close(cropOf(wide, { x: 50, y: 25 }, { x: 0, y: 0 }), { x: 0, y: 0, width: 0.25, height: 0.25 })
    close(cropOf({ ...g(100, 100, 200, 100, 2) }, { x: 300, y: 200 }, { x: 500, y: 300 }), {
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    })
  })
  it('反転した配置では、左右を元画像の向きに戻す', () => {
    close(cropOf({ ...wide, flipped: true }, { x: 0, y: 0 }, { x: 50, y: 25 }), {
      x: 0.75,
      y: 0,
      width: 0.25,
      height: 0.25,
    })
  })
  it('回転した配置では、回す前の向きに戻す', () => {
    // 右へ90度回すと、元画像の左上は右上（150, -50）に来る
    close(cropOf({ ...wide, rotation: 90 }, { x: 150, y: -50 }, { x: 100, y: 50 }), {
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.5,
    })
  })
  it('画像の外まで引いた分は切り捨て、Rust が断る範囲外の値にしない', () => {
    expect(cropOf(wide, { x: -50, y: -50 }, { x: 1000, y: 1000 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    const c = cropOf(wide, { x: 33.3, y: 77.7 }, { x: 999, y: 999 })!
    expect(c.x + c.width).toBeLessThanOrEqual(1)
    expect(c.y + c.height).toBeLessThanOrEqual(1)
  })
  it('画像の外だけを引いたときは null', () => {
    expect(cropOf(wide, { x: -50, y: -50 }, { x: -10, y: 300 })).toBeNull()
  })
})
