// @vitest-environment jsdom
import { act, createElement, StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import type { PaneLayout } from "../src/renderer/src/lib/pane-layout"
import {
  parseAttentionSeen,
  RESORT_INTERVAL_MS,
} from "../src/renderer/src/lib/attention"
import { useAttention } from "../src/renderer/src/lib/use-attention"
import { useDampedOrder } from "../src/renderer/src/lib/use-damped-order"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const SEEN_KEY = "chat-hub.attention.seen"

function harness<P, T>(useHook: (props: P) => T, initial: P) {
  const result = { current: undefined as unknown as T }
  let push: (props: P) => void = () => {}
  function Probe() {
    const [props, setProps] = useState(initial)
    push = setProps
    result.current = useHook(props)
    return null
  }
  const root = createRoot(document.createElement("div"))
  void act(() => {
    root.render(createElement(StrictMode, null, createElement(Probe)))
  })
  return {
    result,
    rerender: (props: P) => {
      void act(() => push(props))
    },
    unmount: () => {
      void act(() => root.unmount())
    },
  }
}

let seq = 0

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  seq += 1
  return {
    id: `s${seq}`,
    title: `Session ${seq}`,
    project: "hub",
    provider: "claude",
    cwd: "/tmp/hub",
    status: "idle",
    createdAt: 1,
    activityAt: 1000,
    updatedAt: 1000,
    ...patch,
  }
}

function layoutFor(ids: (string | null)[]): PaneLayout {
  const panes = (ids.length === 0 ? [null] : ids).map((id, index) => ({
    id: `p${index}`,
    sessionId: id,
    dockOpen: false,
  }))
  return { panes, focusedPaneId: "p0" }
}

type Props = {
  sessions: SessionMeta[]
  layout: PaneLayout
  activeId: string | null
}

function mountAttention(props: Props) {
  return harness(
    (p: Props) => useAttention(p.sessions, p.layout, p.activeId, () => {}),
    props,
  )
}

describe("useAttention", () => {
  beforeEach(() => {
    seq = 0
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("seeds the first run by marking already-done sessions seen", () => {
    const done = session({ status: "done" })
    const waiting = session({ status: "waiting_input" })
    const h = mountAttention({
      sessions: [done, waiting],
      layout: layoutFor([]),
      activeId: null,
    })

    expect(h.result.current.queue.map((s) => s.id)).toEqual([waiting.id])
    expect(parseAttentionSeen(localStorage.getItem(SEEN_KEY))).toEqual({
      [done.id]: 1000,
    })
    h.unmount()
  })

  it("queues an unseen done session when a store already exists", () => {
    localStorage.setItem(SEEN_KEY, "{}")
    const done = session({ status: "done" })
    const h = mountAttention({
      sessions: [done],
      layout: layoutFor([]),
      activeId: null,
    })

    expect(h.result.current.queue.map((s) => s.id)).toEqual([done.id])
    h.unmount()
  })

  it("marks a shown done session seen after one uninterrupted dwell", () => {
    localStorage.setItem(SEEN_KEY, "{}")
    const done = session({ status: "done" })
    const h = mountAttention({
      sessions: [done],
      layout: layoutFor([done.id]),
      activeId: done.id,
    })
    void act(() => window.dispatchEvent(new Event("focus")))

    void act(() => vi.advanceTimersByTime(1_499))
    expect(h.result.current.queue.map((s) => s.id)).toEqual([done.id])

    void act(() => vi.advanceTimersByTime(1))
    expect(h.result.current.queue).toEqual([])
    expect(parseAttentionSeen(localStorage.getItem(SEEN_KEY))).toEqual({
      [done.id]: 1000,
    })
    h.unmount()
  })

  it("keeps sibling dwells running while one session churns", () => {
    localStorage.setItem(SEEN_KEY, "{}")
    const a = session({ status: "done" })
    const b = session({ status: "done" })
    const h = mountAttention({
      sessions: [a, b],
      layout: layoutFor([a.id, b.id]),
      activeId: a.id,
    })
    void act(() => window.dispatchEvent(new Event("focus")))

    void act(() => vi.advanceTimersByTime(1_000))
    const churned = { ...b, activityAt: 2_000, updatedAt: 2_000 }
    h.rerender({
      sessions: [a, churned],
      layout: layoutFor([a.id, b.id]),
      activeId: a.id,
    })

    void act(() => vi.advanceTimersByTime(500))
    expect(h.result.current.queue.map((s) => s.id)).toEqual([b.id])

    void act(() => vi.advanceTimersByTime(1_000))
    expect(h.result.current.queue).toEqual([])
    h.unmount()
  })

  it("never consumes attention while the window is unfocused", () => {
    localStorage.setItem(SEEN_KEY, "{}")
    const done = session({ status: "done" })
    const h = mountAttention({
      sessions: [done],
      layout: layoutFor([done.id]),
      activeId: done.id,
    })

    void act(() => window.dispatchEvent(new Event("blur")))
    void act(() => vi.advanceTimersByTime(60_000))
    expect(h.result.current.queue.map((s) => s.id)).toEqual([done.id])

    void act(() => window.dispatchEvent(new Event("focus")))
    void act(() => vi.advanceTimersByTime(1_500))
    expect(h.result.current.queue).toEqual([])
    h.unmount()
  })
})

describe("useDampedOrder", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mount(ids: string[]) {
    return harness((p: string[]) => useDampedOrder(p), ids)
  }

  it("adopts the first order and follows membership immediately", () => {
    const h = mount(["a", "b"])
    expect(h.result.current).toEqual(["a", "b"])

    h.rerender(["a", "b", "c"])
    expect(h.result.current).toEqual(["a", "b", "c"])

    h.rerender(["a", "c"])
    expect(h.result.current).toEqual(["a", "c"])
    h.unmount()
  })

  it("spends the resort budget once, then holds order until it refills", () => {
    const h = mount(["a", "b"])
    h.rerender(["b", "a"])
    expect(h.result.current).toEqual(["b", "a"])

    void act(() => vi.advanceTimersByTime(1_000))
    h.rerender(["a", "b"])
    expect(h.result.current).toEqual(["b", "a"])

    void act(() => vi.advanceTimersByTime(RESORT_INTERVAL_MS))
    h.rerender(["a", "b", "c"])
    expect(h.result.current).toEqual(["a", "b", "c"])
    h.unmount()
  })

  it("inserts an entrant without reshuffling the held order", () => {
    const h = mount(["a", "b"])
    h.rerender(["b", "a"])
    void act(() => vi.advanceTimersByTime(1_000))

    h.rerender(["a", "n", "b"])
    const held = h.result.current.filter((id) => id !== "n")
    expect(held).toEqual(["b", "a"])
    expect(h.result.current).toContain("n")
    h.unmount()
  })
})
