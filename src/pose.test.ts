import { describe, expect, it } from 'vitest'
import { poseBox, skeleton } from './pose'

// 17点すべてを score で見えているとし、関節 j を (j, j * 2) に置いた人物。hidden の関節は score 0.1
const person = (hidden: number[] = []) =>
  Array.from({ length: 17 }, (_, j) => [j / 100, (j * 2) / 100, hidden.includes(j) ? 0.1 : 0.9]).flat()

describe('poseBox', () => {
  it('長い辺を1とした画像の大きさを返す。ワーカーは関節の座標をサムネイルの長い辺で割っている', () => {
    expect(poseBox({ width: 4000, height: 3000 })).toEqual({ width: 1, height: 0.75 })
    expect(poseBox({ width: 600, height: 1200 })).toEqual({ width: 0.5, height: 1 })
  })
})

describe('skeleton', () => {
  it('COCO 17点のつながりで線を引き、関節に点を置く', () => {
    const { lines, joints } = skeleton([person()])
    expect(joints).toHaveLength(17)
    expect(lines).toHaveLength(19)
    // 左の足首（15）と左の膝（13）を結ぶ
    expect(lines).toContainEqual([
      { x: 0.15, y: 0.3 },
      { x: 0.13, y: 0.26 },
    ])
  })

  it('スコアが0.3未満の関節は点を置かず、その関節につながる線も引かない', () => {
    // 左の膝（13）が見えていない：左の足首と膝、膝と腰の2本が消える
    const { lines, joints } = skeleton([person([13])])
    expect(joints).toHaveLength(16)
    expect(lines).toHaveLength(17)
    expect(joints).not.toContainEqual({ x: 0.13, y: 0.26 })
  })

  it('全員の骨格を出す', () => {
    const { lines, joints } = skeleton([person(), person([0, 1, 2, 3, 4])])
    expect(joints).toHaveLength(17 + 12)
    expect(lines).toHaveLength(19 + 12)
  })
})
