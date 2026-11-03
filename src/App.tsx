import './App.css'

export default function App() {
  return (
    <div className="gallery">
      <header className="gallery__header">
        <span className="gallery__logo">Kura</span>
        <input className="gallery__search" type="search" placeholder="検索" aria-label="検索" />
      </header>

      <nav className="gallery__sidebar" aria-label="サイドバー">
        <ul className="sidebar__list">
          <li className="sidebar__item sidebar__item--selected" aria-current="true">
            すべての画像<span className="sidebar__count">0</span>
          </li>
          <li className="sidebar__item">
            未分類<span className="sidebar__count">0</span>
          </li>
        </ul>
        <h2 className="sidebar__heading">カテゴリ</h2>
        <h2 className="sidebar__heading">タグ</h2>
      </nav>

      <main className="gallery__list" aria-label="画像の一覧" />

      <aside className="gallery__detail" aria-label="詳細">
        <p className="detail__empty">画像を選ぶと、ここに詳細が出ます</p>
      </aside>

      <footer className="gallery__statusbar">0枚</footer>
    </div>
  )
}
