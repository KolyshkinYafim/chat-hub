import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SessionMeta } from "@shared/types"
import { activityStamp } from "@shared/attention"
import type { PaneLayout } from "./pane-layout"
import {
  attentionQueue,
  DONE_SEEN_DWELL_MS,
  isUnseenDone,
  markSeen,
  nextAttention,
  mergeSeen,
  parseAttentionSeen,
  pruneSeen,
  type AttentionSeen,
} from "./attention"
import { useDampedOrder } from "./use-damped-order"

const SEEN_KEY = "chat-hub.attention.seen"

type DwellEntry = { stamp: number; timer: number }

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
  const [boot] = useState(() => {
    const raw = localStorage.getItem(SEEN_KEY)
    return { seen: parseAttentionSeen(raw), stored: raw !== null }
  })
  const [seen, setSeen] = useState<AttentionSeen>(boot.seen)
  const seededRef = useRef(boot.stored)

  useEffect(() => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  }, [seen])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SEEN_KEY) return
      setSeen((curr) => mergeSeen(curr, parseAttentionSeen(e.newValue)))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  useEffect(() => {
    if (seededRef.current || sessions.length === 0) return
    seededRef.current = true
    setSeen((curr) => {
      let next = curr
      for (const s of sessions) {
        if (s.status === "done") next = markSeen(next, s.id, activityStamp(s))
      }
      return next
    })
  }, [sessions])

  useEffect(() => {
    if (sessions.length === 0) return
    const live = new Set(sessions.map((s) => s.id))
    setSeen((curr) => pruneSeen(curr, live))
  }, [sessions])

  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState === "visible",
  )
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())

  useEffect(() => {
    const sync = () => setPageVisible(document.visibilityState === "visible")
    const focus = () => setWindowFocused(true)
    const blur = () => setWindowFocused(false)
    document.addEventListener("visibilitychange", sync)
    window.addEventListener("focus", focus)
    window.addEventListener("blur", blur)
    return () => {
      document.removeEventListener("visibilitychange", sync)
      window.removeEventListener("focus", focus)
      window.removeEventListener("blur", blur)
    }
  }, [])

  const attended = pageVisible && windowFocused

  const visibleDone = useMemo(() => {
    const shown = new Set(layout.panes.map((p) => p.sessionId))
    return sessions.filter((s) => shown.has(s.id) && isUnseenDone(s, seen))
  }, [layout.panes, sessions, seen])

  const dwellRef = useRef(new Map<string, DwellEntry>())

  useEffect(() => {
    const dwells = dwellRef.current
    const wanted = new Map<string, number>()
    if (attended) {
      for (const s of visibleDone) wanted.set(s.id, activityStamp(s))
    }
    for (const [id, entry] of [...dwells]) {
      if (wanted.get(id) === entry.stamp) continue
      window.clearTimeout(entry.timer)
      dwells.delete(id)
    }
    for (const [id, stamp] of wanted) {
      if (dwells.has(id)) continue
      const timer = window.setTimeout(() => {
        dwellRef.current.delete(id)
        setSeen((curr) => markSeen(curr, id, stamp))
      }, DONE_SEEN_DWELL_MS)
      dwells.set(id, { stamp, timer })
    }
  }, [attended, visibleDone])

  useEffect(() => {
    const dwells = dwellRef.current
    return () => {
      for (const { timer } of dwells.values()) window.clearTimeout(timer)
      dwells.clear()
    }
  }, [])

  const liveQueue = useMemo(
    () => attentionQueue(sessions, seen),
    [sessions, seen],
  )
  const liveIds = useMemo(() => liveQueue.map((s) => s.id), [liveQueue])
  const orderedIds = useDampedOrder(liveIds)

  const queue = useMemo(() => {
    const byId = new Map(liveQueue.map((s) => [s.id, s]))
    const out: SessionMeta[] = []
    for (const id of orderedIds) {
      const s = byId.get(id)
      if (s) out.push(s)
    }
    return out
  }, [liveQueue, orderedIds])

  const jumpNext = useCallback(() => {
    const target = nextAttention(queue, activeId)
    if (target) onJump(target.id)
  }, [queue, activeId, onJump])

  return useMemo(
    () => ({ seen, queue, jumpNext }),
    [seen, queue, jumpNext],
  )
}
