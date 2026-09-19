type BackButtonProps = {
  onClick: () => void
  label?: string
}

function BackButton({ onClick, label = 'Back' }: BackButtonProps) {
  return (
    <button
      type="button"
      className="back-button"
      onClick={onClick}
    >
      ‹ {label}
    </button>
  )
}

export default BackButton
