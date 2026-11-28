import type { Category, Image } from './galleryTypes'
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
export type ImageAction =
  | 'similar'
  | 'lastBoard'
  | 'board'
  | 'category'
  | 'parent'
  | 'reveal'
  | 'google'
  | 'hide'
  | 'unhide'
  | 'merge'
  | 'trash'
  | 'restore'
  | 'purge'
  | 'forget'

// lastBoard の名前はボードの名前から作る
export const ACTION_LABELS: Record<Exclude<ImageAction, 'lastBoard'>, string> = {
  similar: '似た画像を探す',
  board: 'ボードに追加…',
  category: 'カテゴリを変える…',
  parent: '1つ上のカテゴリへ移す',
  reveal: 'Finderで表示',
  google: 'Google 画像検索で探す',
  hide: 'NSFWとしてマークする',
  unhide: '隠す印を外す',
  merge: '1枚にまとめる…',
  trash: 'ゴミ箱へ移す',
  restore: '元に戻す',
  purge: '完全に削除…',
  forget: '一覧から外す…',
}

// 一覧と拡大表示で同じメニューにし、詳細パネルの操作を出す。ゴミ箱と見つからない画像は、その画面のパネルの操作だけ
export function imageMenu(
  place: 'gallery' | 'trash' | 'missing',
  // lastBoard：最後に画像を追加したボードが残っているか（FR-712）。merge：類似画像検索の結果のモードか（FR-610）。
  // unmarked、marked：選んだ画像に、隠す印のない画像、ある画像を含むか（FR-513）
  o: {
    count: number
    board: boolean
    lastBoard?: boolean
    similarity: boolean
    merge?: boolean
    unmarked?: boolean
    marked?: boolean
  },
): (ImageAction | 'rule')[] {
  if (place === 'trash') return ['restore', 'purge']
  if (place === 'missing') return ['forget']
  const groups: ImageAction[][] = [
    [
      ...(o.similarity ? ['similar' as const] : []),
      ...(o.board && o.lastBoard ? ['lastBoard' as const] : []),
      ...(o.board ? ['board' as const] : []),
    ],
    // FR-416
    ['category', 'parent'],
    [
      // FR-612 も1枚だけに効く
      ...(o.count === 1 ? (['reveal', 'google'] as const) : []),
      ...(o.unmarked ? ['hide' as const] : []),
      ...(o.marked ? ['unhide' as const] : []),
    ],
    [...(o.merge && o.count >= 2 ? ['merge' as const] : []), 'trash'],
  ]
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? ['rule' as const, ...g] : g))
}

// 「1つ上のカテゴリへ移す」（FR-416）の移す先ごとの画像。カテゴリが揃っていなければ、それぞれの親へ分ける。
// 未分類か一番上の階層のカテゴリの画像を1枚でも含むと、1つ上がないので null（メニューの項目を押せない）
export function parentMoves(
  images: Pick<Image, 'id' | 'category_id'>[],
  categories: Category[],
): { category: number; ids: number[] }[] | null {
  const parents = new Map(categories.map((c) => [c.id, c.parent_id]))
  const groups = new Map<number, number[]>()
  for (const i of images) {
    const parent = i.category_id === null ? null : (parents.get(i.category_id) ?? null)
    if (parent === null) return null
    groups.set(parent, [...(groups.get(parent) ?? []), i.id])
  }
  return images.length ? [...groups].map(([category, ids]) => ({ category, ids })) : null
}
