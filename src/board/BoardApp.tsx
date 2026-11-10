import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../ConfirmDialog'
import { Icon, ICONS } from '../icons'
import { useFlush } from '../flush'
import Status from '../Status'
import Canvas from './Canvas'
import NameDialog from './NameDialog'
import { defaultName } from './names'
import { saveQueue, type SaveState } from './saveQueue'
import type { Added, BoardSummary, Boards, Edit, EditingBoard, Geometry, Item, Snapshot, Viewport } from './types'
import './Board.css'

// 開いたボード。ボードがなければ「ボードを作成」、最後のボードが削除済みなら選択画面（FR-701）
type View = { kind: 'loading' } | { kind: 'empty' } | { kind: 'choose' } | { kind: 'board'; board: EditingBoard }
type Dialog = 'create' | 'rename' | 'delete' | null

// 表示の位置と倍率は、操作が止まってこれだけ経ったら保存する（FR-704）。ホイール1刻みごとには保存しない
const VIEW_SETTLE = 300

// アイデアボードの専用ウィンドウ。ギャラリーの画面とは別に、開くときに読み込む（FR-711）
export default function BoardApp() {
  const [session, setSession] = useState(0)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  // 画面に描く前の、最新の表示。続けて届くホイールと、保存に使う
  const viewNow = useRef(viewport)
  // 表示の保存を待っているタイマー
  const viewTimer = useRef<number>(undefined)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // 追加した配置。キャンバスがこれを全部見える表示にしたら null に戻す
  const [fit, setFit] = useState<number[] | null>(null)
  const fitted = useCallback(() => setFit(null), [])
  // 画像 ID から元画像のパス
  const [paths, setPaths] = useState<Record<number, string>>({})
  // 最後に保存できた revision。次の保存はこれより1つ大きい値で送る。失敗では進めない
  const revision = useRef(0)
  const [save, setSave] = useState<SaveState>({ kind: 'saved' })
  const queue = useRef(
    saveQueue<{ edit: Edit; snapshot: Snapshot }>(async ({ edit, snapshot }) => {
      const saved = await invoke<EditingBoard>('save_board', { edit, revision: revision.current + 1, snapshot })
      revision.current = saved.board.revision
    }, setSave),
  ).current
  // 閉じる・終了・追加の保存待ちの間（held）と、追加の後に開き直す間（revealing）は編集を受け付けない。
  // 受け付けると、Rust が保存を確かめた後の変更が、閉じたボードや終わった編集へ送られて消える
  const held = useRef(false)
  const revealing = useRef(0)
  const locked = useCallback(() => held.current || revealing.current > 0, [])
  useFlush(async () => {
    settleView()
    held.current = true
    await queue.flush()
  })

  const current = view.kind === 'board' ? view.board.board : null
  const latest = useRef(view)
  latest.current = view

  // 配置と表示をまとめて保存のキューに入れる。表示だけの保存を待っていたら、ここに含めて取り消す
  function commit(edit: Edit, items: Item[]) {
    clearTimeout(viewTimer.current)
    viewTimer.current = undefined
    queue.push({
      edit,
      snapshot: {
        viewport: viewNow.current,
        items: items.map((i) => ({ id: i.id, source_id: i.source.id, geometry: i.geometry })),
      },
    })
  }

  // 待っている表示の保存を、今キューに入れる。閉じる・切り替えの前の保存待ちに含めるため
  function settleView() {
    if (viewTimer.current === undefined) return
    const v = latest.current
    if (v.kind === 'board') commit(v.board.edit, v.board.board.items)
  }
  const settleRef = useRef(settleView)
  settleRef.current = settleView

  // 表示の位置と倍率を変える（FR-703）。保存は、操作が止まってから1度だけ送る
  const look = useCallback(
    (update: (viewport: Viewport) => Viewport) => {
      if (locked()) return
      viewNow.current = update(viewNow.current)
      setViewport(viewNow.current)
      clearTimeout(viewTimer.current)
      viewTimer.current = window.setTimeout(() => settleRef.current(), VIEW_SETTLE)
    },
    [locked],
  )
  // ウィンドウを破棄するときに、タイマーを残さない
  useEffect(() => () => clearTimeout(viewTimer.current), [])
  const summary = boards.find((b) => b.id === current?.id)

  async function reload() {
    const list = await invoke<Boards>('list_boards')
    setSession(list.session)
    setBoards(list.boards)
    return list
  }

  function show(board: EditingBoard, select: number[] = []) {
    setView({ kind: 'board', board })
    clearTimeout(viewTimer.current)
    viewTimer.current = undefined
    viewNow.current = board.board.viewport
    setViewport(board.board.viewport)
    setSelected(new Set(select))
    revision.current = board.board.revision
  }

  // 開けたかを返す。開けなければ今の表示のままエラーを出す。
  // 今のボードを保存できなければ切り替えない（FR-704）。失敗は保存の状態に出す
  async function open(id: number, s = session, select: number[] = []) {
    setError(null)
    settleView()
    try {
      await queue.flush()
    } catch {
      return false
    }
    try {
      show(await invoke<EditingBoard>('open_board', { session: s, id }), select)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }

  // ギャラリーから追加したボードを開き、追加分を選んで全部見える表示にする（FR-701）。追加がなければ false。
  // 開いたときの分は1度だけ受け取る。開発時の StrictMode が開く処理を2回流しても、2回目に追加を失わないため
  const mounted = useRef<Promise<Added | null>>(null)
  async function reveal(s: number, onMount = false) {
    const take = () => invoke<Added | null>('take_board_reveal')
    const added = await (onMount ? (mounted.current ??= take()) : take())
    if (!added) return false
    if (await open(added.board_id, s, added.placements)) setFit(added.placements)
    return true
  }
  // 追加の後に開き直し終わるまで、編集を止める。Rust の release はこれより先に届く
  async function revealAfterAdd() {
    revealing.current++
    try {
      await revealRef.current((await reload()).session)
    } catch (e) {
      setError(String(e))
    } finally {
      revealing.current--
    }
  }
  const revealRef = useRef(reveal)
  revealRef.current = reveal

  // 開いただけでは空のボードを作らない
  useEffect(() => {
    reload()
      .then(async (list) => {
        if (await reveal(list.session, true)) return
        // 最後のボードを開けなければ、ほかのボードを選べるよう選択画面にする
        if (list.last_board_id !== null && (await open(list.last_board_id, list.session))) return
        setView({ kind: list.boards.length ? 'choose' : 'empty' })
      })
      .catch((e) => {
        setError(String(e))
        setView({ kind: 'choose' })
      })
    // 開いている間の追加。ボードが増えたかもしれないので一覧も読み直す
    const unlisten = [
      getCurrentWindow().listen('board-reveal', () => revealAfterAdd()),
      // Rust の保存待ちが終わった（遷移を中止した、または追加し終えた）。ギャラリー宛ての release では戻さない
      getCurrentWindow().listen('release', () => (held.current = false)),
    ]
    return () => unlisten.forEach((p) => p.then((f) => f()))
    // 開いたときに1度だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const items = view.kind === 'board' ? view.board.board.items : null
  // 元画像のパスは Rust が DB から組み立てる。ゴミ箱・見つからない・削除された画像は枠だけを出す。
  // 読めなかった画像も空のパスとして覚え、読み直しを繰り返さない
  useEffect(() => {
    const ids = [
      ...new Set((items ?? []).filter((i) => i.source.status === 'available').map((i) => i.source.image_id!)),
    ].filter((id) => !(id in paths))
    if (!ids.length) return
    Promise.all(
      ids.map((id) =>
        invoke<{ path: string }>('image_detail', { id }).then(
          (d) => [id, d.path] as const,
          () => [id, ''] as const,
        ),
      ),
    ).then((found) => setPaths((p) => ({ ...p, ...Object.fromEntries(found) })))
  }, [items, paths])

  // 配置の変更を画面に出して保存する（FR-702、FR-704）。保存中も失敗しても、変えた状態のまま見せる。
  // 配置を変える操作は、すべてここを通す
  function apply(change: (items: Item[]) => Item[]) {
    if (view.kind !== 'board' || locked()) return
    const { edit, board } = view.board
    const items = change(board.items)
    setView({ kind: 'board', board: { edit, board: { ...board, items } } })
    commit(edit, items)
  }

  // 移動と拡大・縮小。ドラッグを終えたときに1度だけ届く
  function reshape(changed: Map<number, Geometry>) {
    apply((items) => items.map((i) => (changed.has(i.id) ? { ...i, geometry: changed.get(i.id)! } : i)))
  }

  // 選んだ配置をボードから外す。スナップショットから外すだけで、元画像と同じ画像の別の配置は変わらない（FR-702）
  function discard() {
    if (view.kind !== 'board' || locked()) return
    const { id, items } = view.board.board
    const left = items.filter((i) => !selected.has(i.id))
    apply(() => left)
    setSelected(new Set())
    // 削除の確認と選択画面に出す件数を合わせる。一覧は読み直さない
    setBoards((list) => list.map((b) => (b.id === id ? { ...b, placement_count: left.length } : b)))
  }

  function select(ids: number[]) {
    if (!locked()) setSelected(new Set(ids))
  }

  async function create(name: string) {
    // 今のボードを保存できなければ新しいボードに移らない
    settleView()
    await queue.flush().catch(() => {
      throw '今のボードを保存できないため、新しいボードを作れません'
    })
    const board = await invoke<EditingBoard>('create_board', { session, name })
    setDialog(null)
    setError(null)
    show(board)
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
    clearTimeout(viewTimer.current)
    viewTimer.current = undefined
    queue.clear()
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
                <div ref={menu} id="board-menu" className="menu" role="menu" popover="auto">
                  <button type="button" role="menuitem" className="menu__item" onClick={() => act('rename')}>
                    名前を変更…
                  </button>
                  <button type="button" role="menuitem" className="menu__item" onClick={() => act('delete')}>
                    削除…
                  </button>
                </div>
              </>
            )}
            <button type="button" className="button" onClick={() => setDialog('create')}>
              <Icon d={ICONS.plus} />
              新しいボード
            </button>
            {current && (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={!current.items.length}
                  onClick={() => setFit(current.items.map((i) => i.id))}
                >
                  <Icon d={ICONS.maximize} />
                  全体を表示
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!selected.size}
                  onClick={() => setFit([...selected])}
                >
                  <Icon d={ICONS.scan} />
                  選択画像を表示
                </button>
              </>
            )}
            {current && save.kind !== 'failed' && (
              <span className="board__save" role="status">
                {save.kind === 'saving' ? '保存中…' : '保存済み'}
              </span>
            )}
          </header>
          {current && save.kind === 'failed' && (
            <div className="board__error" role="alert">
              <Status kind="error">保存できませんでした（{save.error}）</Status>
              <button type="button" className="button" onClick={() => queue.retry()}>
                再試行
              </button>
            </div>
          )}
          {error && (
            <div className="board__error" role="alert">
              <Status kind="error">{error}</Status>
            </div>
          )}
          {current ? (
            <Canvas
              board={current}
              paths={paths}
              viewport={viewport}
              selected={selected}
              fit={fit}
              locked={locked}
              onViewport={look}
              onFitted={fitted}
              onSelect={select}
              onGeometry={reshape}
              onRemove={discard}
            />
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
