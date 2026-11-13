// ボードの自動保存の状態（FR-704）。未保存の変更を保存済みと示さない
export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; error: string }

// 保存を1つずつ送る。保存中に重ねた変更は、終わってから最後の1つだけを送る。
// revision は保存が成功するたびに進むので、同時に2つ送ると後の要求が断られるため。
// 失敗したら変更を残して止まり、retry か次の変更か flush でもう一度送る
export function saveQueue<T>(send: (snapshot: T) => Promise<void>, onState: (state: SaveState) => void) {
  let pending: { snapshot: T } | null = null
  let running: Promise<void> | null = null
  let error: unknown = null

  async function run() {
    while (pending) {
      const { snapshot } = pending
      pending = null
      onState({ kind: 'saving' })
      try {
        await send(snapshot)
      } catch (e) {
        // 保存中に新しい変更が来ていれば、そちらを残す
        pending ??= { snapshot }
        error = e
        onState({ kind: 'failed', error: String(e) })
        return
      }
    }
    error = null
    onState({ kind: 'saved' })
  }

  function kick() {
    running ??= run().finally(() => (running = null))
    return running
  }

  return {
    push(snapshot: T) {
      pending = { snapshot }
      kick()
    },
    retry() {
      kick()
    },
    // 送らずに捨てる。ボードを削除して、残った変更の行き先がなくなったときに使う
    clear() {
      pending = null
      if (!running) onState({ kind: 'saved' })
    },
    // 保存中なら終わるまで待つ。前に失敗して残った変更があれば送り直す。保存できなければ reject する
    async flush() {
      if (running) await running
      else if (pending) await kick()
      if (pending) throw error
    },
  }
}
