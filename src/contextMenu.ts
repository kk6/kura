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
    // ウィンドウの右や下にはみ出す分だけ戻す。小さくしたボードのウィンドウでも、下の項目を押せるようにする
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, at.x - Math.max(0, r.right - window.innerWidth))}px`
    menu.style.top = `${Math.max(0, at.y - Math.max(0, r.bottom - window.innerHeight))}px`
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
