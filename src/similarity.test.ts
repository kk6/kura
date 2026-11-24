import { describe, expect, test } from 'vitest'
import { changeWeight, DEFAULT_WEIGHT, fillWeights, rankSimilar, type Similar } from './similarity'

const similar = (base: number | null, rows: [number, number, number][]): Similar & { base: number | null } => ({
  base,
  aspects: ['content', 'composition'],
  ids: rows.map((r) => r[0]),
  scores: [rows.map((r) => r[1]), rows.map((r) => r[2])],
  uncomputed: 0,
  skipped: {},
})

describe('rankSimilar', () => {
  // 1 が基準。2 は内容だけ、3 は構図だけが似ている
  const s = similar(1, [
    [1, 0, 0],
    [2, 2, -1],
    [3, -1, 2],
    [4, 0.8, 0.8],
  ])

  test('重みを掛けて足した値の大きい順に並べ、基準画像は値によらず先頭に置く', () => {
    expect(rankSimilar(s, { content: 50, composition: 50 })).toEqual([1, 4, 2, 3])
  })

  test('構図を0にすると内容だけの並びになる', () => {
    expect(rankSimilar(s, { content: 50, composition: 0 })).toEqual([1, 2, 4, 3])
  })

  test('内容を0にすると構図だけの並びになる', () => {
    expect(rankSimilar(s, { content: 0, composition: 100 })).toEqual([1, 3, 4, 2])
  })

  test('ライブラリの外の画像で探したときは、基準画像を置かずに値の大きい順に並べる', () => {
    const outside = similar(null, [
      [1, 0, 0],
      [2, 2, -1],
      [3, -1, 2],
    ])
    expect(rankSimilar(outside, { content: 100, composition: 0 })).toEqual([2, 1, 3])
  })

  test('同じ値なら id の小さい順', () => {
    expect(
      rankSimilar(
        similar(9, [
          [5, 1, 1],
          [3, 1, 1],
          [9, 0, 0],
        ]),
        { content: 1, composition: 1 },
      ),
    ).toEqual([9, 3, 5])
  })
})

describe('fillWeights', () => {
  test('保存した値がなければ、どの観点も同じ初期値', () => {
    expect(fillWeights(['content', 'composition'], {})).toEqual({
      content: DEFAULT_WEIGHT,
      composition: DEFAULT_WEIGHT,
    })
  })

  test('無い観点だけを初期値で埋め、範囲の外の値は端に寄せる', () => {
    expect(fillWeights(['content', 'composition', 'pose'], { content: 130, composition: 20.4 })).toEqual({
      content: 100,
      composition: 20,
      pose: DEFAULT_WEIGHT,
    })
  })

  test('どれも0なら初期値に戻す', () => {
    const w = fillWeights(['content', 'composition'], { content: 0, composition: 0 })
    expect(w).toEqual({ content: DEFAULT_WEIGHT, composition: DEFAULT_WEIGHT })
  })
})

describe('changeWeight', () => {
  test('ほかの観点に0でない値があれば0にできる', () => {
    expect(changeWeight({ content: 30, composition: 40 }, 'content', 0)).toEqual({ content: 0, composition: 40 })
  })

  test('最後の1つは0にならず、1で止まる', () => {
    expect(changeWeight({ content: 0, composition: 40 }, 'composition', 0)).toEqual({ content: 0, composition: 1 })
  })
})

describe('rankSimilar（ポーズの重みを足した3本）', () => {
  // 1 が基準。2 は似たポーズ、3 は人物がいない（ポーズは平均の0）、4 は似ていないポーズ。内容と構図は同じ
  const s: Similar & { base: number } = {
    base: 1,
    aspects: ['content', 'composition', 'pose'],
    ids: [1, 2, 3, 4],
    scores: [
      [1, 0.1, 0.1, 0.1],
      [1, 0, 0, 0],
      [3, 1.2, 0, -1.2],
    ],
    uncomputed: 0,
    skipped: {},
  }

  test('ポーズの重みを上げると似たポーズが上に来て、人物のいない画像は真ん中に残る', () => {
    expect(rankSimilar(s, { content: 50, composition: 50, pose: 100 })).toEqual([1, 2, 3, 4])
  })

  test('ポーズを0にすると、内容と構図だけの並びになる', () => {
    const flat = { ...s, scores: [[1, 0.1, 0.3, 0.2], [1, 0, 0, 0], s.scores[2]] }
    expect(rankSimilar(flat, { content: 50, composition: 50, pose: 0 })).toEqual([1, 3, 4, 2])
  })

  test('比べなかった観点の重みは並びに使わない', () => {
    const skipped = {
      ...s,
      aspects: ['content', 'composition'],
      scores: [
        [1, 0.3, 0.2, 0.1],
        [1, 0, 0, 0],
      ],
      skipped: { pose: 'none' as const },
    }
    expect(rankSimilar(skipped, { content: 50, composition: 50, pose: 100 })).toEqual([1, 2, 3, 4])
  })
})

describe('fillWeights（3a で保存した重み）', () => {
  test('3a で保存した内容と構図の値はそのままで、ポーズだけ初期値で埋める', () => {
    expect(fillWeights(['content', 'composition', 'pose'], { content: 30, composition: 100 })).toEqual({
      content: 30,
      composition: 100,
      pose: DEFAULT_WEIGHT,
    })
  })
})
