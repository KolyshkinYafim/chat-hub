import { useEffect, useRef, type RefObject } from "react"

/**
 * Close a popover when the next press lands outside it. On mousedown rather
 * than click so the popover is gone before the press turns into a click on
 * whatever is underneath. The callback is held in a ref, so an inline arrow at
 * the call site does not re-register the listener on every render.
 */
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  const latest = useRef(onDismiss)
  latest.current = onDismiss

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) latest.current()
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [ref, open])
}
