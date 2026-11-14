import { ConfirmDialog } from 'kura'

export const EmptyTrash = () => (
  <ConfirmDialog title="ゴミ箱を空にしますか？" confirm="空にする" onConfirm={() => {}} onClose={() => {}}>
    ゴミ箱の 24 件の画像を完全に削除します。この操作は取り消せません。
  </ConfirmDialog>
)
