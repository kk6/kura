import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo } from 'react'
import guide from '../../docs/user-guide.md?raw'
import { renderGuide } from './guide'
import './Help.css'

// ビルドのたびに docs/user-guide.md と画像を画面に入れる。ネットワークにつながっていなくても読める（NFR-14）
const images = import.meta.glob<string>('../../docs/images/*', { eager: true, query: '?url', import: 'default' })

export default function HelpApp() {
  const html = useMemo(() => renderGuide(guide, images), [])
  useEffect(() => {
    // メニューの「すべてを選択」は ⌘A として届く。ヘルプには選ぶ画像がないので、本文の文字を選ぶ
    const selectAll = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'a' && !e.isTrusted) document.execCommand('selectAll')
    }
    window.addEventListener('keydown', selectAll)
    return () => window.removeEventListener('keydown', selectAll)
  }, [])
  return (
    <main
      className="help"
      aria-label="Kura ヘルプ"
      // 中身はアプリに入れた docs/user-guide.md だけ
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // 見出しへのリンクはヘルプの中で移る。外へのリンクはヘルプのウインドウで開かず、既定のブラウザで開く
        const href = (e.target as Element).closest('a')?.getAttribute('href')
        if (!href || href.startsWith('#')) return
        e.preventDefault()
        invoke('open_help_link', { url: href }).catch((err) => console.error(err))
      }}
    />
  )
}
