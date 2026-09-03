import { useEffect, useRef, type RefObject } from "react"

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export type OverlayCursor = {
  count: number
  active: number
  onMove: (index: number) => void
  onCommit?: (event: KeyboardEvent) => void
  keys?: "arrows" | "tab"
  wrap?: boolean
}

export type OverlayOptions = {
  onClose: () => void
  enabled?: boolean
  trapRef?: RefObject<HTMLElement | null>
  cursor?: OverlayCursor
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled"),
  )
}

export function moveCursor(
  active: number,
  delta: number,
  count: number,
  wrap: boolean,
): number | null {
  if (count <= 0) return null
  const from = Math.min(Math.max(active, 0), count - 1)
  if (wrap) return (from + delta + count) % count
  return Math.min(Math.max(from + delta, 0), count - 1)
}

function trapTab(root: HTMLElement, event: KeyboardEvent): void {
  const nodes = focusables(root)
  if (nodes.length === 0) {
    event.preventDefault()
    return
  }
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const current = document.activeElement
  if (event.shiftKey && (current === first || !root.contains(current))) {
    event.preventDefault()
    last.focus()
  } else if (
    !event.shiftKey &&
    (current === last || !root.contains(current))
  ) {
    event.preventDefault()
    first.focus()
  }
}

export function useOverlay(options: OverlayOptions): void {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const enabled = options.enabled !== false
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      const { onClose, trapRef, cursor } = latest.current
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === "Tab") {
        if (cursor?.keys === "tab") {
          event.preventDefault()
          event.stopPropagation()
          const next = moveCursor(
            cursor.active,
            event.shiftKey ? -1 : 1,
            cursor.count,
            cursor.wrap !== false,
          )
          if (next !== null) cursor.onMove(next)
          return
        }
        const root = trapRef?.current
        if (root) trapTab(root, event)
        return
      }
      if (
        cursor &&
        (cursor.keys ?? "arrows") === "arrows" &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        const next = moveCursor(
          cursor.active,
          event.key === "ArrowDown" ? 1 : -1,
          cursor.count,
          cursor.wrap === true,
        )
        if (next === null) return
        event.preventDefault()
        cursor.onMove(next)
        return
      }
      if (event.key === "Enter") cursor?.onCommit?.(event)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [enabled])
}
