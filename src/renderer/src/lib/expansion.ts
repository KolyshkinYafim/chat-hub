import { useState } from "react"

/**
 * Expansion outlives a remount: a streaming turn re-renders the whole
 * transcript, and a card that snapped shut mid-read is worse than no card.
 */
const expansionRememberedAcrossMounts = new Map<string, boolean>()

export function useExpanded(key: string, initial: boolean) {
  const [open, setOpen] = useState(
    () => expansionRememberedAcrossMounts.get(key) ?? initial,
  )
  const toggle = () => {
    const next = !open
    expansionRememberedAcrossMounts.set(key, next)
    setOpen(next)
  }
  return [open, toggle] as const
}
