import type { ReactNode } from 'react'
import './Status.css'

export type StatusKind = 'error' | 'warning' | 'success' | 'info'

// docs/design.md「状態の表示」。色の見分けにくい環境や読み上げでも区別できるよう、色・アイコンの形・先頭の言葉の3つで示す
const PREFIX: Record<StatusKind, string> = {
  error: 'エラー：',
  warning: '注意：',
  success: '完了：',
  info: 'お知らせ：',
}

const ICON: Record<StatusKind, ReactNode> = {
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3L2 21h20z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
}

export default function Status({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  return (
    <span className={`status status--${kind}`}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {ICON[kind]}
      </svg>
      <span>
        {PREFIX[kind]}
        {children}
      </span>
    </span>
  )
}
