// 設定のページの ON/OFF（8章）。見た目はサイドバーの AND と OR のスイッチと同じで、全体を1つのボタンにし、押すたびに切り替わる
export default function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  // 項目の名前。画面では左に出し、読み上げではスイッチの名前にする
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <span className="settings__item">
      <span aria-hidden>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`switch${checked ? ' switch--right' : ''}`}
        onClick={() => onChange(!checked)}
      >
        {['オフ', 'オン'].map((text, i) => (
          <span key={text} className={`switch__option${(i === 1) === checked ? ' switch__option--on' : ''}`}>
            {text}
          </span>
        ))}
      </button>
    </span>
  )
}
