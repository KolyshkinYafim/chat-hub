import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionMeta, SessionStatus } from "../src/shared/types"

const shown = vi.hoisted(() => [] as { title: string; body: string; silent: boolean }[])

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true
    }

    constructor(
      private readonly opts: { title: string; body: string; silent: boolean },
    ) {}

    show() {
      shown.push(this.opts)
    }
  },
  shell: { beep: vi.fn() },
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
  })

  it("notifies on a transition into waiting_input, once per stretch", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("waiting_input"))
    svc.handle(statusEvent("waiting_input"))
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe("Session needs input")
    expect(shown[0].silent).toBe(false)
  })

  it("notifies again after the session ran in between", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("waiting_input"))
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("waiting_input"))
    expect(shown).toHaveLength(2)
  })

  it("stays quiet for running, idle and error statuses", () => {
    const svc = new NotificationService(() => session())
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("idle"))
    svc.handle(statusEvent("error"))
    expect(shown).toHaveLength(0)
  })

  it("plays the completion sound only when the toggle is on, and mutes the banner", () => {
    const play = vi.fn()
    let enabled = false
    const svc = new NotificationService(() => session(), () => enabled, play)
    svc.handle(statusEvent("done"))
    expect(play).not.toHaveBeenCalled()
    expect(shown[0].silent).toBe(false)

    enabled = true
    svc.handle(statusEvent("running"))
    svc.handle(statusEvent("done"))
    expect(play).toHaveBeenCalledTimes(1)
    expect(shown[1].silent).toBe(true)
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
})
