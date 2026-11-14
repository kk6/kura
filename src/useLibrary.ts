import { invoke } from '@tauri-apps/api/core'
import { useCallback, useState } from 'react'
import { addCategory, editCategories, editImages, moveImages, named, removeCategory, replaceTag } from './galleryData'
import type { Assigned, Deleted, Gallery, Image, Tag } from './galleryTypes'
import type { Result } from './StatusbarResult'

const EMPTY: Gallery = { images: [], categories: [], tags: [] }

// 開いているライブラリの一覧（画像・カテゴリ・タグ、ゴミ箱、見つからない画像）と、一覧だけを変える操作。
// 選択や絞り込みも一緒に変える操作（ゴミ箱、タグの統合と削除など）は Gallery に置き、update で一覧を変える。
// 別々に state を変えると、消えた画像を選んだままの画面が一度描かれるため
export function useLibrary(report: (result: Result) => void) {
  const [data, setData] = useState(EMPTY)
  // ゴミ箱の画像（FR-511）
  const [trash, setTrash] = useState<Image[]>([])
  // 見つからない画像（FR-104）
  const [missing, setMissing] = useState<Image[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // 読み直した画像を返す。読めなければ空。起動時の effect から呼ぶので、参照を変えない
  const reload = useCallback(async () => {
    try {
      const g = await invoke<Gallery>('load_gallery')
      setData(g)
      setLoadError(null)
      return g.images
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }, [])
  const reloadTrash = useCallback(async () => {
    try {
      const t = await invoke<Image[]>('load_trash')
      setTrash(t)
      return t
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }, [])
  const reloadMissing = useCallback(async () => {
    try {
      const m = await invoke<Image[]>('load_missing')
      setMissing(m)
      return m
    } catch (e) {
      setLoadError(String(e))
      return []
    }
  }, [])

  // 移した画像のカテゴリとファイル名を手元の値に反映し、移せなかった画像をファイル名で返す
  function applyMoved(r: Assigned, category: number | null) {
    setData((d) => moveImages(d, r.moved, category))
    return named(r.failed, data.images)
  }

  async function assign(targets: number[], category: number | null) {
    const r = await invoke<Assigned>('set_category', { ids: targets, category })
    report({ kind: 'assigned', moved: r.moved.length, failed: applyMoved(r, category) })
  }

  async function renameImage(id: number, stem: string) {
    const file_name = await invoke<string>('rename_image', { id, stem })
    setData((d) => editImages(d, [id], (i) => ({ ...i, file_name })))
  }

  async function rate(id: number, rating: number) {
    await invoke('set_rating', { id, rating })
    setData((d) => editImages(d, [id], (i) => ({ ...i, rating })))
  }

  async function renameCategory(id: number, name: string) {
    await invoke('rename_category', { id, name })
    const nfc = name.normalize('NFC')
    setData((d) => editCategories(d, [id], (c) => ({ ...c, name: nfc })))
  }

  async function createCategory(parent: number | null, name: string) {
    const id = await invoke<number>('create_category', { parent, name })
    setData((d) => addCategory(d, { id, name: name.normalize('NFC'), parent_id: parent, collapsed: false }))
  }

  async function moveCategory(id: number, parent: number | null) {
    try {
      await invoke('move_category', { id, parent })
      setData((d) => editCategories(d, [id], (c) => ({ ...c, parent_id: parent })))
    } catch (e) {
      report({ kind: 'error', message: `カテゴリを移せません（${e}）` })
    }
  }

  async function collapseCategories(ids: number[], collapsed: boolean) {
    setData((d) => editCategories(d, ids, (c) => ({ ...c, collapsed })))
    // 開閉を覚えられなくても操作は続けられるので、知らせるだけにする
    await invoke('set_categories_collapsed', { ids, collapsed }).catch((e) =>
      report({ kind: 'error', message: `カテゴリの開閉を保存できません（${e}）` }),
    )
  }

  async function deleteCategory(id: number) {
    const name = data.categories.find((c) => c.id === id)?.name ?? ''
    let r: Deleted
    try {
      r = await invoke<Deleted>('delete_category', { id })
    } catch (e) {
      report({ kind: 'error', message: `カテゴリを削除できません（${e}）` })
      return
    }
    const failed = applyMoved(r, null)
    if (r.error !== null) {
      report({ kind: 'error', message: `「${name}」を削除できません（${r.error}）`, failed })
      return
    }
    setData((d) => removeCategory(d, id))
    report({ kind: 'deleted', name, moved: r.moved.length })
  }

  async function renameTag(id: number, name: string) {
    const tag = await invoke<Tag>('rename_tag', { id, name })
    setData((d) => replaceTag(d, tag))
  }

  return {
    data,
    trash,
    missing,
    loadError,
    reload,
    reloadTrash,
    reloadMissing,
    update: setData,
    assign,
    renameImage,
    rate,
    renameCategory,
    createCategory,
    moveCategory,
    collapseCategories,
    deleteCategory,
    renameTag,
  }
}
