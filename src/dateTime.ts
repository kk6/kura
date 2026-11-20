// 日時の表示（年/月/日 時:分）。詳細パネルの取り込み日と、管理情報を戻す前の確認で使う
const pad = (n: number) => String(n).padStart(2, '0')

export const dateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
