export type Toast = {
  id: number
  text: string
  actionLabel?: string
  onAction?: () => void
}

export const MAX_TOASTS = 3
export const TOAST_DISMISS_MS = 6000

export function pushToast(list: Toast[], toast: Toast): Toast[] {
  const next = [...list.filter((t) => t.id !== toast.id), toast]
  return next.slice(-MAX_TOASTS)
}

export function dismissToast(list: Toast[], id: number): Toast[] {
  return list.filter((t) => t.id !== id)
}
