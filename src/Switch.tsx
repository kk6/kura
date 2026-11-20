// 設定のページの ON/OFF（8章）。見た目はサイドバーの AND と OR のスイッチと同じで、全体を1つのボタンにし、押すたびに切り替わる
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
      className={`switch${checked ? ' switch--right' : ''}`}
      onClick={() => onChange(!checked)}
    >
      {['OFF', 'ON'].map((text, i) => (
        <span key={text} className={`switch__option${(i === 1) === checked ? ' switch__option--on' : ''}`}>
          {text}
        </span>
      ))}
    </button>
  )
}
