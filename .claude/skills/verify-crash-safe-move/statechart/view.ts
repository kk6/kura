export const title = "画像を動かす手順と落ちた後の復旧";

const LABEL: Record<string, string> = {
  start: "操作の前",
  recorded: "予定を記録した（画像は元の場所）",
  copying: "一時ファイルへコピー中",
  tmpReady: "画像が一時ファイルにある",
  renamed: "画像は移動先、DB は元の場所のまま",
  settle: "ファイルの場所を見て片付け方を決める",
  settleDrop: "一時ファイルを片付けた、予定は残る",
  applyErr: "DB の更新に失敗、予定が残る",
  recover: "起動して、残った予定を確かめる",
  done: "完了：予定なし、DB とファイルが一致",
};
export const state = (v: any) => LABEL[v.pc] ?? v.pc;

export const group = (v: any) =>
  v.pc === "done" ? "完了" : ["settle", "settleDrop", "applyErr", "recover"].includes(v.pc) ? "片付け" : "手順";
export const colors = { 手順: "blue", 片付け: "orange", 完了: "teal" };

export const step = (a: string, f: any, t: any) => {
  switch (a) {
    case "Record": return "予定を DB に記録する";
    case "RenameSrcDst": return "移動先の名前に変える [移動]";
    case "RenameSrcTmp": return "一時ファイルの名前に変える [大文字・小文字だけの変更]";
    case "CopyBegin": return "一時ファイルへコピーを始める [取り込み]";
    case "CopyEnd": return "コピーが終わる";
    case "RenameTmpDst": return "一時ファイルを移動先の名前に変える";
    case "OpFails": return "名前の変更かコピーが失敗する";
    case "Finish": return t.pc === "done" ? "DB を移動先に向け、予定を消す" : "DB の更新が失敗する";
    case "Settle":
      if (t.pc === "settleDrop") return f.mode === "copy" ? "一時ファイルを消す" : "一時ファイルを元の名前に戻す";
      if (t.pc === "applyErr") return "DB の更新が失敗する";
      if (t.pc === "left") return "片付け方を決められない";
      return f.file.dst !== "none" && !(f.mode !== "copy" && f.file.src !== "none")
        ? "移動先にあるので、DB を移動先に向けて予定を消す"
        : "移動していないので、予定だけ消す";
    case "SettleDrop": return "予定を消す";
    case "Recover": return t.pc === "settle" ? "予定が残っているので片付ける" : "予定がないので何もしない";
    case "Reopen": return "利用者がライブラリを開き直す";
    case "Crash": return f.pc === "done" ? null : "アプリが落ちる";
    default: return null; // Done: the end state's stutter
  }
};
