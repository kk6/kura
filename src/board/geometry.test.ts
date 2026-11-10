import { describe, expect, it } from 'vitest'
import { bounds, fitView, intersects, resizeFactor, scaleAbout, toBoard, zoomAt, MAX_ZOOM, MIN_ZOOM } from './geometry'
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
