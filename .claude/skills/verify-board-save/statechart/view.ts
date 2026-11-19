export const title = "ボードの自動保存"

const upToDate = (v: any) => v.saved === v.latest || v.latest <= v.dropped

const screen = (v: any) => {
  if (v.shown === "saving") return "保存中"
  if (v.shown === "failed") return "保存できませんでした（変更は残る）"
  const label = upToDate(v) ? "保存済み" : "保存済みと表示、最後の変更は未保存"
  return v.running === 0 ? label : `${label}（送り終えた直後）`
}

const closing = (v: any) => {
  switch (v.fpc) {
    case "waiting":
    case "wake":
      return "保存を待っている"
    case "resolved":
      return v.fok ? "保存して閉じた" : "閉じた、最後の変更は未保存"
    case "rejected":
      return "保存できず閉じない"
    default:
      return "開いている"
  }
}

export const state = (v: any) => ({ 画面: screen(v), 閉じる: closing(v) })

export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "Push": return "ボードを編集する"
    case "Retry": return "再試行を押す"
    case "Clear": return f.running !== 0 ? "ボードを削除する（送り終わる前）" : "ボードを削除する"
    case "SendOk": return t.shown === "saving" ? "保存が成功し、次の変更を送る" : "保存が成功する"
    case "SendFail": return "保存が失敗する"
    case "Finally": return "後片付けが済む"
    case "FlushStart":
      if (t.fpc === "resolved") return "閉じる・切り替える（送る変更はない）"
      return f.running !== 0 ? "閉じる・切り替える（送り終わりを待つ）" : "閉じる・切り替える（残った変更を送る）"
    case "FlushResume": return t.fpc === "rejected" ? "残った変更があるので閉じない" : "待ち終えて閉じる"
    default: return null
  }
}
