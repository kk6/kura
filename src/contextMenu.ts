import { useEffect, useRef, useState } from 'react'

// 右クリックのメニューの位置。右クリックを離したときに閉じないよう、自動では閉じないポップオーバー（popover="manual"）に
// ref を付けて使う。メニューの外を押す、Escape、スクロール、ウィンドウを離れる、のどれかで閉じる
export function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    const menu = ref.current!
    menu.showPopover()
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return
        // 選択を外す Escape として扱わない
        e.stopPropagation()
      } else if (e.target instanceof Node && menu.contains(e.target)) return
      setAt(null)
    }
    const events = ['pointerdown', 'keydown', 'scroll'] as const
    events.forEach((type) => document.addEventListener(type, close, true))
    window.addEventListener('blur', close)
    return () => {
      events.forEach((type) => document.removeEventListener(type, close, true))
      window.removeEventListener('blur', close)
    }
  }, [at])
  return { at, setAt, ref }
}
