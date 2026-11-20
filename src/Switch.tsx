// 設定のページの ON/OFF（8章）。字のないトグルで、押すたびに切り替わる（docs/design.md「設定のページ」）
export default function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  // 項目の名前。画面では行の左に出ているので、読み上げのスイッチの名前にだけ使う
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="toggle"
      onClick={() => onChange(!checked)}
    />
  )
}
