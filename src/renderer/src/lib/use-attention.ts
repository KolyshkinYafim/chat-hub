import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SessionMeta } from "@shared/types"
import type { PaneLayout } from "./pane-layout"
import {
  attentionQueue,
  DONE_SEEN_DWELL_MS,
  isUnseenDone,
  markSeen,
  nextAttention,
  pruneSeen,
  type AttentionSeen,
} from "./attention"

const SEEN_KEY = "chat-hub.attention.seen"

export function loadAttentionSeen(): AttentionSeen {
  const raw = localStorage.getItem(SEEN_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) out[id] = at
    }
    return out
  } catch {
    return {}
  }
}

function saveAttentionSeen(seen: AttentionSeen): void {
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
}

export function useAttention(
  sessions: SessionMeta[],
  layout: PaneLayout,
  activeId: string | null,
  onJump: (id: string) => void,
): {
  seen: AttentionSeen
  queue: SessionMeta[]
  jumpNext: () => void
} {
  const [seen, setSeen] = useState<AttentionSeen>(loadAttentionSeen)
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  )

  useEffect(() => {
    const sync = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [])

  const commitSeen = useCallback(
    (update: (curr: AttentionSeen) => AttentionSeen) => {
      setSeen((curr) => {
        const next = update(curr)
        if (next !== curr) saveAttentionSeen(next)
        return next
      })
    },
    [],
  )

  useEffect(() => {
    if (sessions.length === 0) return
    const live = new Set(sessions.map((s) => s.id))
    commitSeen((curr) => pruneSeen(curr, live))
  }, [sessions, commitSeen])

  const visibleDone = useMemo(() => {
    const shown = new Set(layout.panes.map((p) => p.sessionId))
    return sessions.filter((s) => shown.has(s.id) && isUnseenDone(s, seen))
  }, [layout.panes, sessions, seen])

  const visibleDoneRef = useRef(visibleDone)
  useEffect(() => {
    visibleDoneRef.current = visibleDone
  }, [visibleDone])

  const visibleDoneKey = visibleDone
    .map((s) => `${s.id}:${s.updatedAt}`)
    .join("|")

  useEffect(() => {
    if (!pageVisible || visibleDoneKey === "") return
    const timers = visibleDoneRef.current.map((s) => {
      const id = s.id
      const at = s.updatedAt
      return window.setTimeout(() => {
        commitSeen((curr) => markSeen(curr, id, at))
      }, DONE_SEEN_DWELL_MS)
    })
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [pageVisible, visibleDoneKey, commitSeen])

  const queue = useMemo(() => attentionQueue(sessions, seen), [sessions, seen])

  const jumpNext = useCallback(() => {
    const target = nextAttention(queue, activeId)
    if (target) onJump(target.id)
  }, [queue, activeId, onJump])

  return useMemo(
    () => ({ seen, queue, jumpNext }),
    [seen, queue, jumpNext],
  )
}
