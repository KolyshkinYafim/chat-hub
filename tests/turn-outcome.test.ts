import { describe, expect, it } from "vitest"
import { RESTART_CUT_TITLE } from "@shared/notices"
import type { ChatMessage, SessionUsage } from "@shared/types"
import { turnOutcome } from "@renderer/lib/turn-outcome"
import { sessionStateLine } from "@renderer/lib/session-state-line"
import type { SessionMeta } from "@shared/types"

const assistant = (items: ChatMessage["items"] = []): ChatMessage => ({
  id: "a1",
  sessionId: "s1",
  role: "assistant",
  content: "done",
  createdAt: 1,
  items,
})
const tool = (status: "completed" | "failed") =>
  ({ id: `t-${status}`, kind: "tool", status, name: "Shell" }) as NonNullable<ChatMessage["items"]>[number]

const usage: SessionUsage = {
  turns: 1,
  costUsd: 1.17,
  lastTurn: { costUsd: 1.17, durationMs: 130_000 },
}

describe("turnOutcome", () => {
  it("is silent while a turn runs — the live ticker owns that slot", () => {
    expect(turnOutcome({ status: "running" }, [assistant()], usage)).toBeNull()
  })

  it("says a finished turn is finished, with its steps, time and cost", () => {
    const outcome = turnOutcome(
      { status: "idle" },
      [assistant([tool("completed"), tool("completed"), tool("failed")])],
      usage,
    )
    expect(outcome?.tone).toBe("done")
    expect(outcome?.facts).toEqual(["3 steps", "1 failed", "2m 10s", "$1.17"])
    expect(outcome?.messageId).toBe("a1")
  })

  it("names the restart cut rather than calling it an error", () => {
    const cut = assistant([
      tool("completed"),
      { id: "n", kind: "notice", status: "interrupted", level: "warning", title: RESTART_CUT_TITLE },
    ])
    expect(turnOutcome({ status: "error" }, [cut], null)?.tone).toBe("interrupted")
    expect(turnOutcome({ status: "error" }, [assistant()], null)?.tone).toBe("error")
  })

  it("points at the question when the agent is waiting", () => {
    expect(turnOutcome({ status: "waiting_input" }, [assistant()], null)?.tone).toBe("waiting")
  })

  it("has nothing to say before the first reply", () => {
    expect(turnOutcome({ status: "idle" }, [], null)).toBeNull()
  })
})

describe("sessionStateLine", () => {
  const meta = (status: SessionMeta["status"], live?: SessionMeta["live"]): SessionMeta =>
    ({ id: "s", title: "t", project: "p", provider: "claude", cwd: "/", status, createdAt: 0, updatedAt: 0, live }) as SessionMeta

  it("shows the step a working chat is on", () => {
    expect(
      sessionStateLine(meta("running", { phase: "tool", stepLabel: "Shell", stepDetail: "git status", since: 0, startedAt: 0 })),
    ).toBe("Shell · git status")
  })

  it("says nothing for a chat at rest", () => {
    expect(sessionStateLine(meta("idle"))).toBeNull()
    expect(sessionStateLine(meta("done"))).toBeNull()
  })

  it("names the wait, the failure and the restart cut", () => {
    expect(sessionStateLine(meta("waiting_input"))).toBe("Waiting for your answer")
    expect(sessionStateLine(meta("error"))).toBe("Stopped with an error")
    const cut = assistant([
      { id: "n", kind: "notice", status: "interrupted", level: "warning", title: RESTART_CUT_TITLE },
    ])
    expect(sessionStateLine(meta("error"), [cut])).toBe("Interrupted by a restart — send “continue”")
  })
})
