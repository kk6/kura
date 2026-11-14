import { describe, expect, it } from 'vitest'
import { actualSize, clampView, FIT, panView, scaleOf, zoomRange, zoomViewAt } from './zoomView'

// 枠 800×600 に 1600×1200 の画像を出すと、枠に合わせた倍率は 0.5
const BIG = { width: 1600, height: 1200 }
// 枠 800×600 に 200×300 の画像を出すと、枠に合わせた倍率は 2（高さで決まる）
const SMALL = { width: 200, height: 300 }
const FRAME = { width: 800, height: 600 }

describe('scaleOf', () => {
  it('画像の1ピクセルを画面の何ポイントで出すかを返す。枠に合わせた大きさが 1', () => {
    expect(scaleOf(FIT, BIG, FRAME)).toBe(0.5)
    expect(scaleOf(FIT, SMALL, FRAME)).toBe(2)
    expect(scaleOf({ zoom: 4, x: 0, y: 0 }, BIG, FRAME)).toBe(2)
  })
})

describe('zoomRange', () => {
  it('大きい画像は枠に合わせた大きさより小さくせず、原寸の 800% まで大きくする', () => {
    expect(zoomRange(BIG, FRAME)).toEqual({ min: 1, max: 16 })
  })

  it('小さい画像は原寸まで小さくでき、800% まで大きくする', () => {
    expect(zoomRange(SMALL, FRAME)).toEqual({ min: 0.5, max: 4 })
  })
})

describe('clampView', () => {
  it('倍率を範囲に収める', () => {
    expect(clampView({ zoom: 0.2, x: 0, y: 0 }, BIG, FRAME).zoom).toBe(1)
    expect(clampView({ zoom: 99, x: 0, y: 0 }, BIG, FRAME).zoom).toBe(16)
  })

  it('画像が枠より大きい向きは端が枠の内側に入らないよう、枠以下の向きは中央に置く', () => {
    // 2倍で 1600×1200。横は (1600-800)/2=400、縦は (1200-600)/2=300 まで動かせる
    expect(clampView({ zoom: 2, x: 999, y: -999 }, BIG, FRAME)).toEqual({ zoom: 2, x: 400, y: -300 })
    expect(clampView({ zoom: 1, x: 50, y: 50 }, BIG, FRAME)).toEqual({ zoom: 1, x: 0, y: 0 })
  })
})

describe('zoomViewAt', () => {
  it('point（枠の中央から測った位置）の下に見えている画像の点を動かさない', () => {
    // 右上 (200, -100) を中心に2倍にすると、中央は (-200, 100) へずれる
    expect(zoomViewAt(FIT, BIG, FRAME, { x: 200, y: -100 }, 2)).toEqual({ zoom: 2, x: -200, y: 100 })
  })

  it('範囲の端では倍率を止め、ずれも止めた倍率の分だけにする', () => {
    expect(zoomViewAt({ zoom: 16, x: 0, y: 0 }, BIG, FRAME, { x: 100, y: 0 }, 2)).toEqual({ zoom: 16, x: 0, y: 0 })
  })
})

describe('panView', () => {
  it('動かした分だけずらし、範囲に収める', () => {
    expect(panView({ zoom: 2, x: 0, y: 0 }, BIG, FRAME, 30, -40)).toEqual({ zoom: 2, x: 30, y: -40 })
    expect(panView({ zoom: 2, x: 390, y: 0 }, BIG, FRAME, 30, 0)).toEqual({ zoom: 2, x: 400, y: 0 })
  })
})

describe('actualSize', () => {
  it('画像の1ピクセルを画面の1ポイントにし、今見ている中央を保つ', () => {
    expect(actualSize({ zoom: 1, x: 0, y: 0 }, BIG, FRAME)).toEqual({ zoom: 2, x: 0, y: 0 })
    expect(actualSize({ zoom: 4, x: 400, y: 0 }, BIG, FRAME)).toEqual({ zoom: 2, x: 200, y: 0 })
    expect(scaleOf(actualSize(FIT, SMALL, FRAME), SMALL, FRAME)).toBe(1)
  })
})
