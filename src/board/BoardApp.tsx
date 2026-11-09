import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../ConfirmDialog'
import { Icon, ICONS } from '../icons'
import Status from '../Status'
import NameDialog from './NameDialog'
import { defaultName } from './names'
import type { BoardSummary, Boards, EditingBoard } from './types'
import './Board.css'

// 開いたボード。ボードがなければ「ボードを作成」、最後のボードが削除済みなら選択画面（FR-701）
type View = { kind: 'loading' } | { kind: 'empty' } | { kind: 'choose' } | { kind: 'board'; board: EditingBoard }
type Dialog = 'create' | 'rename' | 'delete' | null

// アイデアボードの専用ウィンドウ。ギャラリーの画面とは別に、開くときに読み込む（FR-711）
export default function BoardApp() {
  const [session, setSession] = useState(0)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const menu = useRef<HTMLDivElement>(null)

  const current = view.kind === 'board' ? view.board.board : null
  const summary = boards.find((b) => b.id === current?.id)

  async function reload() {
    const list = await invoke<Boards>('list_boards')
    setSession(list.session)
    setBoards(list.boards)
    return list
  }

  async function open(id: number, s = session) {
    setError(null)
    try {
      setView({ kind: 'board', board: await invoke<EditingBoard>('open_board', { session: s, id }) })
    } catch (e) {
      setError(String(e))
    }
  }

  // 開いただけでは空のボードを作らない
  useEffect(() => {
    reload()
      .then((list) => {
        if (list.last_board_id !== null) return open(list.last_board_id, list.session)
        setView({ kind: list.boards.length ? 'choose' : 'empty' })
      })
      .catch((e) => {
        setError(String(e))
        setView({ kind: 'choose' })
      })
    // 開いたときに1度だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create(name: string) {
    const board = await invoke<EditingBoard>('create_board', { session, name })
    setDialog(null)
    setError(null)
    setView({ kind: 'board', board })
    await reload()
  }

  async function rename(name: string) {
    const renamed = await invoke<BoardSummary>('rename_board', { session, id: current!.id, name })
    setDialog(null)
    setBoards((list) => list.map((b) => (b.id === renamed.id ? renamed : b)))
    setView((v) =>
      v.kind === 'board'
        ? { kind: 'board', board: { ...v.board, board: { ...v.board.board, name: renamed.name } } }
        : v,
    )
  }

  // 失敗したら今のボードを開いたままエラーを出す
  async function remove() {
    setDialog(null)
    try {
      await invoke('delete_board', { session, id: current!.id })
    } catch (e) {
      setError(String(e))
      return
    }
    setError(null)
    const list = await reload().catch(() => ({ boards: boards.filter((b) => b.id !== current!.id) }))
    setView({ kind: list.boards.length ? 'choose' : 'empty' })
  }

  function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    // ポップオーバーは最前面の層に出るので、ボタンの真下へ置く
    const r = e.currentTarget.getBoundingClientRect()
    menu.current?.style.setProperty('top', `${r.bottom}px`)
    menu.current?.style.setProperty('left', `${r.left}px`)
  }

  function act(next: Dialog) {
    menu.current?.hidePopover()
    setDialog(next)
  }

  const names = boards.map((b) => b.name)
  const placementCount = summary?.placement_count ?? current?.items.length ?? 0

  if (view.kind === 'loading') return null
  return (
    <div className="board">
      {view.kind === 'empty' ? (
        <main className="board__empty" aria-label="アイデアボード">
          <p>ボードはまだありません。</p>
          <button type="button" className="button button--primary" onClick={() => setDialog('create')}>
            <Icon d={ICONS.plus} />
            ボードを作成
          </button>
          {error && (
            <span role="alert">
              <Status kind="error">{error}</Status>
            </span>
          )}
        </main>
      ) : (
        <>
          <header className="board__toolbar">
            <select
              className="board__select"
              aria-label="ボード"
              value={current?.id ?? ''}
              onChange={(e) => open(Number(e.target.value))}
            >
              {!current && (
                <option value="" disabled>
                  ボードを選ぶ
                </option>
              )}
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {current && (
              <>
                <button
                  type="button"
                  className="button button--icon"
                  aria-label="ボードの操作"
                  title="ボードの操作"
                  aria-haspopup="menu"
                  popoverTarget="board-menu"
                  onClick={openMenu}
                >
                  <Icon d={ICONS.ellipsis} />
                </button>
                <div ref={menu} id="board-menu" className="board__menu" role="menu" popover="auto">
                  <button type="button" role="menuitem" className="board__menu-item" onClick={() => act('rename')}>
                    名前を変更…
                  </button>
                  <button type="button" role="menuitem" className="board__menu-item" onClick={() => act('delete')}>
                    削除…
                  </button>
                </div>
              </>
            )}
            <button type="button" className="button" onClick={() => setDialog('create')}>
              <Icon d={ICONS.plus} />
              新しいボード
            </button>
          </header>
          {error && (
            <div className="board__error" role="alert">
              <Status kind="error">{error}</Status>
            </div>
          )}
          {current ? (
            <main className="board__canvas" aria-label={`キャンバス：${current.name}`} />
          ) : (
            <main className="board__choose" aria-label="ボードを選ぶ">
              <p>開くボードを選んでください。</p>
              <ul className="board__list">
                {boards.map((b) => (
                  <li key={b.id}>
                    <button type="button" className="board__list-item" onClick={() => open(b.id)}>
                      <span>{b.name}</span>
                      <span className="board__count">{b.placement_count}枚</span>
                    </button>
                  </li>
                ))}
              </ul>
            </main>
          )}
        </>
      )}
      {dialog === 'create' && (
        <NameDialog
          title="新しいボード"
          action="作成"
          initial={defaultName(names)}
          onSubmit={create}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'rename' && current && (
        <NameDialog
          title="ボードの名前を変更"
          action="変更"
          initial={current.name}
          onSubmit={rename}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && current && (
        <ConfirmDialog title="ボードを削除" confirm="削除する" onConfirm={remove} onClose={() => setDialog(null)}>
          「{current.name}」と、置いた画像 {placementCount}
          枚の配置を削除します。元の画像はライブラリに残ります。削除は取り消せません。
        </ConfirmDialog>
      )}
    </div>
  )
}
