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
        // 目次と本文の中の見出しへのリンクだけを動かす。ほかの文書と外のページのリンクは扱いを決めていないので開かない
        const a = (e.target as Element).closest('a')
        if (a && !a.getAttribute('href')?.startsWith('#')) e.preventDefault()
      }}
    />
  )
}
