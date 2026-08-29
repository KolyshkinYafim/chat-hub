import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionMeta, SessionStatus } from "../src/shared/types"

const shown = vi.hoisted(() => [] as { title: string; body: string; silent: boolean }[])
const clicks = vi.hoisted(() => [] as (() => void)[])

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true
    }

    constructor(
      private readonly opts: { title: string; body: string; silent: boolean },
    ) {}

    on(event: string, handler: () => void) {
      if (event === "click") clicks.push(handler)
      return this
    }

    show() {
      shown.push(this.opts)
    }
  },
}))

const { NotificationService } = await import("../src/main/notifications")

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Refactor the auth flow",
    project: "hub",
    provider: "claude",
    cwd: "/tmp/hub",
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

function statusEvent(status: SessionStatus, id = "s1") {
  return { type: "session.status" as const, id, status }
}

describe("NotificationService", () => {
  beforeEach(() => {
    shown.length = 0
    clicks.length = 0
  })

  it("notifies on a transition into waiting_input, once per stretch", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("waiting_input"))
    svc.handle(statusEvent("waiting_input"))
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe("Session needs input")
    expect(shown[0].silent).toBe(true)
  })

  it("treats an intervening running status as the same waiting stretch", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("waiting_input"))
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("waiting_input"))
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("waiting_input"))
    expect(shown).toHaveLength(1)
  })

  it("starts a new waiting stretch after done, idle or error", () => {
    for (const between of ["done", "idle", "error"] as const) {
      shown.length = 0
      const svc = new NotificationService(() => session())
      svc.handle(statusEvent("waiting_input"))
      svc.handle(statusEvent(between))
      svc.handle(statusEvent("waiting_input"))
      const waits = shown.filter((n) => n.title === "Session needs input")
      expect(waits).toHaveLength(2)
    }
  })

  it("stays quiet for running, idle and error statuses", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("idle"))
    svc.handle(statusEvent("error"))
    expect(shown).toHaveLength(0)
  })

  it("notifies done again when a later turn finishes, not on a republish", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("done"))
    svc.handle(statusEvent("done"))
    expect(shown).toHaveLength(1)
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("done"))
    expect(shown).toHaveLength(2)
    expect(shown[1].title).toBe("Session finished")
  })

  it("lets the banner carry the sound only when the toggle is on", () => {
    let enabled = false
    const svc = new NotificationService(() => session(), () => enabled)
    svc.handle(statusEvent("done"))
    expect(shown[0].silent).toBe(true)

    enabled = true
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("done"))
    expect(shown[1].silent).toBe(false)
  })

  it("forgets a killed session so its next life notifies afresh", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("waiting_input"))
    svc.handle({ type: "session.ended", id: "s1", reason: "killed" })
    svc.handle(statusEvent("waiting_input"))
    expect(shown).toHaveLength(2)
  })

  it("falls back to the session id when the session is unknown", () => {
    const svc = new NotificationService(() => undefined)
    svc.handle(statusEvent("done", "ghost"))
    expect(shown[0].body).toBe("ghost")
  })

  it("hands the clicked session to the focus hook", () => {
    const focused: string[] = []
    const svc = new NotificationService(
      () => session(),
      () => false,
      (id) => focused.push(id),
    )
    svc.handle(statusEvent("waiting_input", "s7"))
    expect(clicks).toHaveLength(1)
    clicks[0]?.()
    expect(focused).toEqual(["s7"])
  })

  it("survives a click with no focus hook wired", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("done"))
    expect(() => clicks[0]?.()).not.toThrow()
  })
})
