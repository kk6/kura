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

// 画像の右クリックのメニューに出す操作（FR-515）。'rule' は区切り線
export type ImageAction = 'similar' | 'lastBoard' | 'board' | 'reveal' | 'trash' | 'restore' | 'purge' | 'forget'

// lastBoard の名前はボードの名前から作る
export const ACTION_LABELS: Record<Exclude<ImageAction, 'lastBoard'>, string> = {
  similar: '似た画像を探す',
  board: 'ボードに追加…',
  reveal: 'Finderで表示',
  trash: 'ゴミ箱へ移す',
  restore: '元に戻す',
  purge: '完全に削除…',
  forget: '一覧から外す…',
}

// 一覧と拡大表示で同じメニューにし、詳細パネルの操作を出す。ゴミ箱と見つからない画像は、その画面のパネルの操作だけ
export function imageMenu(
  place: 'gallery' | 'trash' | 'missing',
  // lastBoard：最後に画像を追加したボードが残っているか（FR-712）
  o: { count: number; board: boolean; lastBoard?: boolean; similarity: boolean },
): (ImageAction | 'rule')[] {
  if (place === 'trash') return ['restore', 'purge']
  if (place === 'missing') return ['forget']
  const groups: ImageAction[][] = [
    [
      ...(o.similarity ? ['similar' as const] : []),
      ...(o.board && o.lastBoard ? ['lastBoard' as const] : []),
      ...(o.board ? ['board' as const] : []),
    ],
    o.count === 1 ? ['reveal'] : [],
    ['trash'],
  ]
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? ['rule' as const, ...g] : g))
}
