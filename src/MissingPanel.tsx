import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

// 見つからない画像（FR-104）を開いている間に、詳細パネルの場所に出す
export default function MissingPanel({ selected, onForget }: { selected: number; onForget: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <aside className="gallery__detail" aria-label="見つからない画像">
      <h2 className="detail__name">{selected ? `${selected}枚を選んでいます` : '見つからない画像'}</h2>
      <p className="detail__note">
        Finder
        で消したか、ライブラリの外へ移した画像です。ファイルを元の場所に戻すか、ライブラリの中に置いて「差分を確認」を押すと、タグとメモを残したまま一覧に戻ります。
      </p>
      <div className="detail__actions">
        <button type="button" className="button" disabled={!selected} onClick={() => setConfirming(true)}>
          DBから外す
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="選んだ画像をDBから外す"
          confirm="外す"
          onConfirm={() => {
            setConfirming(false)
            onForget()
          }}
          onClose={() => setConfirming(false)}
        >
          選んだ画像 {selected}枚のタグ、メモ、評価を削除します。元に戻せません。
        </ConfirmDialog>
      )}
    </aside>
  )
}
