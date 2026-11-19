import { describe, expect, it } from 'vitest'
import { saveQueue, type SaveState } from './saveQueue'

// 応答を手で返せる保存。送った順に記録する
function fakeSend() {
  const sent: number[] = []
  const calls: { resolve: () => void; reject: (e: unknown) => void }[] = []
  const send = (snap: number) =>
    new Promise<void>((resolve, reject) => {
      sent.push(snap)
      calls.push({ resolve, reject })
    })
  return { send, sent, calls }
}

const tick = () => new Promise((r) => setTimeout(r))

describe('saveQueue', () => {
  it('保存中に重ねた変更は、終わってから最後の1つだけを送る', async () => {
    const { send, sent, calls } = fakeSend()
    const states: SaveState[] = []
    const q = saveQueue(send, (s) => states.push(s))
    q.push(1)
    q.push(2)
    q.push(3)
    await tick()
    calls[0].resolve()
    await tick()
    calls[1].resolve()
    await q.flush()
    expect(sent).toEqual([1, 3])
    expect(states.at(-1)).toEqual({ kind: 'saved' })
  })

  it('失敗したら変更を残して失敗を示し、再試行で同じ変更を送る', async () => {
    const { send, sent, calls } = fakeSend()
    const states: SaveState[] = []
    const q = saveQueue(send, (s) => states.push(s))
    q.push(1)
    await tick()
    calls[0].reject('readonly')
    await tick()
    expect(states.at(-1)).toEqual({ kind: 'failed', error: 'readonly' })
    q.retry()
    await tick()
    calls[1].resolve()
    await q.flush()
    expect(sent).toEqual([1, 1])
    expect(states.at(-1)).toEqual({ kind: 'saved' })
  })

  it('失敗の後に新しい変更があれば、失敗した変更ではなく新しい変更を送る', async () => {
    const { send, sent, calls } = fakeSend()
    const q = saveQueue(send, () => {})
    q.push(1)
    await tick()
    calls[0].reject('readonly')
    await tick()
    q.push(2)
    await tick()
    calls[1].resolve()
    await q.flush()
    expect(sent).toEqual([1, 2])
  })

  it('flush は保存し終えるまで待ち、保存できなければ reject して変更を残す', async () => {
    const { send, calls } = fakeSend()
    const q = saveQueue(send, () => {})
    q.push(1)
    const flushed = q.flush()
    await tick()
    calls[0].reject('readonly')
    await expect(flushed).rejects.toBe('readonly')
    // 残した変更は次の flush でもう一度送る
    const again = q.flush()
    await tick()
    calls[1].resolve()
    await expect(again).resolves.toBeUndefined()
  })

  it('変更がなければ flush はすぐ終わる', async () => {
    const { send, sent } = fakeSend()
    await saveQueue(send, () => {}).flush()
    expect(sent).toEqual([])
  })

  it('clear で残った変更を捨てると、flush は何も送らずに終わる', async () => {
    const { send, sent, calls } = fakeSend()
    const states: SaveState[] = []
    const q = saveQueue(send, (s) => states.push(s))
    q.push(1)
    await tick()
    calls[0].reject('readonly')
    await tick()
    q.clear()
    await q.flush()
    expect(sent).toEqual([1])
    expect(states.at(-1)).toEqual({ kind: 'saved' })
  })

  // 保存の応答と同じ回のマイクロタスクで変更が来る場合。何段後に来ても同じに動くことを確かめる
  // （.claude/skills/verify-board-save の反例）
  const later = (depth: number, f: () => void) => {
    let p = Promise.resolve()
    for (let i = 0; i < depth; i++) p = p.then(() => {})
    void p.then(f)
  }

  it.each([0, 1, 2, 3, 4])(
    '保存が終わった直後（%i 段後）の変更も送り、送り終えるまで保存済みと示さない',
    async (depth) => {
      const { send, sent, calls } = fakeSend()
      const states: SaveState[] = []
      const q = saveQueue(send, (s) => states.push(s))
      q.push(1)
      calls[0].resolve()
      later(depth, () => q.push(2))
      await tick()
      expect(sent).toEqual([1, 2])
      expect(states.at(-1)).toEqual({ kind: 'saving' })
      calls[1].resolve()
      await tick()
      expect(states.at(-1)).toEqual({ kind: 'saved' })
    },
  )

  it('flush を待つ間に来た変更も、保存し終えてから flush が終わる', async () => {
    const { send, calls } = fakeSend()
    // 1 を保存し終えたと知らせた、その同じ塊で 2 を足す
    const q = saveQueue(send, (s) => {
      if (s.kind === 'saved' && calls.length === 1) q.push(2)
    })
    q.push(1)
    let settled = false
    const flushed = q.flush().finally(() => (settled = true))
    calls[0].resolve()
    await tick()
    expect(calls).toHaveLength(2)
    expect(settled).toBe(false)
    calls[1].resolve()
    await expect(flushed).resolves.toBeUndefined()
  })
})
