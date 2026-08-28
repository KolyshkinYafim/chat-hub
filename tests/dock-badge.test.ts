import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HubEvent, SessionMeta } from "../src/shared/types"

const badges = vi.hoisted(() => [] as string[])

vi.mock("electron", () => ({
  app: {
    dock: {
      setBadge: (text: string) => {
        badges.push(text)
      },
    },
  },
}))

const { wireDockBadge } = await import("../src/main/dock-badge")

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
    updatedAt: 2,
    ...patch,
  }
}

function makeBus() {
  const listeners: ((event: HubEvent) => void)[] = []
  return {
    on(listener: (event: HubEvent) => void) {
      listeners.push(listener)
      return () => {}
    },
    emit(event: HubEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

describe("wireDockBadge", () => {
  beforeEach(() => {
    badges.length = 0
    seq = 0
  })

  it("shows the needsAction count until a renderer reports", () => {
    const bus = makeBus()
    wireDockBadge(
      bus,
      () => [session({ status: "waiting_input" }), session()],
      "darwin",
    )
    expect(badges).toEqual(["1"])
  })

  it("counts from the sessions.replaced payload in one pass", () => {
    const bus = makeBus()
    const listSessions = vi.fn(() => [] as SessionMeta[])
    wireDockBadge(bus, listSessions, "darwin")
    expect(listSessions).toHaveBeenCalledTimes(1)

    bus.emit({
      type: "sessions.replaced",
      sessions: [
        session({ status: "waiting_input" }),
        session({ status: "error" }),
        session({ status: "error", archived: true }),
      ],
    })
    expect(badges).toEqual(["", "2"])
    expect(listSessions).toHaveBeenCalledTimes(1)

    bus.emit({ type: "session.status", id: "s1", status: "waiting_input" })
    expect(badges).toEqual(["", "2"])
  })

  it("prefers the renderer count and falls back once it is cleared", () => {
    const bus = makeBus()
    const badge = wireDockBadge(
      bus,
      () => [session({ status: "error" })],
      "darwin",
    )
    expect(badges).toEqual(["1"])

    badge.setRendererCount(3)
    expect(badges).toEqual(["1", "3"])

    bus.emit({ type: "sessions.replaced", sessions: [] })
    expect(badges).toEqual(["1", "3"])

    badge.clearRendererCount()
    expect(badges).toEqual(["1", "3", ""])
  })

  it("never repeats the same badge text", () => {
    const bus = makeBus()
    const badge = wireDockBadge(bus, () => [], "darwin")
    badge.setRendererCount(2)
    badge.setRendererCount(2)
    bus.emit({
      type: "sessions.replaced",
      sessions: [session({ status: "error" }), session({ status: "error" })],
    })
    expect(badges).toEqual(["", "2"])
  })

  it("does nothing off macOS", () => {
    const bus = makeBus()
    const listSessions = vi.fn(() => [] as SessionMeta[])
    const badge = wireDockBadge(bus, listSessions, "linux")
    badge.setRendererCount(4)
    expect(listSessions).not.toHaveBeenCalled()
    expect(badges).toEqual([])
  })
})
