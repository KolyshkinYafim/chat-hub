import { useEffect } from "react"
import { TOAST_DISMISS_MS, type Toast } from "../lib/toasts"

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div className="toast" role="status">
      <span className="toast-text">{toast.text}</span>
      {toast.actionLabel && toast.onAction ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.onAction?.()
            onDismiss(toast.id)
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        className="icon-chip xs ghost"
        title="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  )
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
