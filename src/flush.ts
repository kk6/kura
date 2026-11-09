import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef } from 'react'

// 閉じる・終了・切り替えの前に保存するもの（ボードの配置、入力中のメモ）。保存できなければ reject する
type Saver = () => Promise<void>
const savers = new Set<Saver>()

// このウィンドウの未保存の変更をすべて保存する。1つでも失敗したら最初の失敗で reject する
export async function flushAll() {
  const results = await Promise.allSettled([...savers].map((save) => save()))
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
}

// 部品が表示されている間だけ、閉じる前の保存に加える
export function useFlush(save: Saver) {
  const ref = useRef(save)
  ref.current = save
  useEffect(() => {
    const saver = () => ref.current()
    savers.add(saver)
    return () => {
      savers.delete(saver)
    }
  }, [])
}

// Rust の保存待ち（src-tauri/src/settle.rs）に答える。受け取れるようになってから Rust に知らせる。
// 知らせる前のウィンドウには保存するものがないので、Rust は待たずに進める
export async function serveFlush() {
  await listen<number>('flush', (e) =>
    flushAll().then(
      () => invoke('flush_done', { id: e.payload, error: null }),
      (error) => invoke('flush_done', { id: e.payload, error: String(error) }),
    ),
  )
  await invoke('flush_ready')
}
