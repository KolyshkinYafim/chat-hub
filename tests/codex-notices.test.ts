import { describe, expect, it } from "vitest"
import {
  codexNotice,
  NOTICE_BACKLOG,
  queueNotice,
  readRateLimits,
} from "../src/main/adapters/codex"
import type { ServerNotification } from "../src/main/codex-protocol/generated/ServerNotification"

/**
 * The app-server's commentary on its own run. All of it was dropped, which is
 * how a broken Code Mode reached the reader as "I couldn't run the command"
 * with the explanation discarded from the same stream.
 */
function notification(method: string, params: unknown): ServerNotification {
  return { method, params } as ServerNotification
}

function hookRun(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hook-1",
    eventName: "preToolUse",
    handlerType: "command",
    executionMode: "blocking",
    scope: "project",
    sourcePath: "/w/.codex/hooks.toml",
    source: "config",
    displayOrder: 0n,
    status: "completed",
    statusMessage: null,
    startedAt: 0n,
    completedAt: 1n,
    durationMs: 1n,
    entries: [],
    ...patch,
  }
}

describe("codexNotice", () => {
  it("keeps a plain warning, which is the one that explains a bad turn", () => {
    expect(
      codexNotice(
        notification("warning", { threadId: null, message: "Code Mode is unavailable" }),
      ),
    ).toMatchObject({ level: "warning", title: "Code Mode is unavailable" })
  })

  it("carries a config warning's details and the file it came from", () => {
    expect(
      codexNotice(
        notification("configWarning", {
          summary: "Unknown key in config",
          details: "model_reasoning_efort is not a setting",
          path: "/w/.codex/config.toml",
        }),
      ),
    ).toMatchObject({
      level: "warning",
      title: "Unknown key in config",
      detail: "model_reasoning_efort is not a setting",
      source: "/w/.codex/config.toml",
    })
  })

  it("files a deprecation as a note rather than a warning", () => {
    expect(
      codexNotice(
        notification("deprecationNotice", { summary: "--full-auto is going away", details: null }),
      ),
    ).toMatchObject({ level: "info", title: "--full-auto is going away" })
  })

  it("reports an MCP server that would not start, and why", () => {
    expect(
      codexNotice(
        notification("mcpServer/startupStatus/updated", {
          threadId: null,
          name: "linear",
          status: "failed",
          error: "connect ECONNREFUSED",
          failureReason: "reauthenticationRequired",
        }),
      ),
    ).toMatchObject({
      level: "warning",
      title: "MCP server linear needs signing in again",
      detail: "connect ECONNREFUSED",
      source: "linear",
    })
  })

  it("stays quiet about an MCP server that came up fine", () => {
    expect(
      codexNotice(
        notification("mcpServer/startupStatus/updated", {
          threadId: null,
          name: "linear",
          status: "ready",
          error: null,
          failureReason: null,
        }),
      ),
    ).toBeNull()
  })

  it("gives every MCP server its own card so one cannot hide another", () => {
    const first = codexNotice(
      notification("mcpServer/startupStatus/updated", {
        threadId: null,
        name: "linear",
        status: "failed",
        error: null,
        failureReason: null,
      }),
    )
    const second = codexNotice(
      notification("mcpServer/startupStatus/updated", {
        threadId: null,
        name: "slack",
        status: "failed",
        error: null,
        failureReason: null,
      }),
    )
    expect(first?.id).not.toBe(second?.id)
  })

  it("reports a hook that blocked the agent", () => {
    expect(
      codexNotice(
        notification("hook/completed", {
          threadId: "t1",
          turnId: "r1",
          run: hookRun({ status: "blocked", statusMessage: "edits to /etc are refused" }),
        }),
      ),
    ).toMatchObject({
      level: "warning",
      title: "Hook preToolUse blocked",
      detail: "edits to /etc are refused",
    })
  })

  it("reports a hook that let the turn through but warned about it", () => {
    expect(
      codexNotice(
        notification("hook/completed", {
          threadId: "t1",
          turnId: "r1",
          run: hookRun({ entries: [{ kind: "warning", text: "lockfile is stale" }] }),
        }),
      ),
    ).toMatchObject({ level: "info", detail: "lockfile is stale" })
  })

  it("says nothing about a hook that ran cleanly and printed nothing", () => {
    expect(
      codexNotice(
        notification("hook/completed", { threadId: "t1", turnId: "r1", run: hookRun() }),
      ),
    ).toBeNull()
  })

  it("ignores the notifications that already have a home", () => {
    expect(
      codexNotice(notification("turn/completed", { turn: { status: "completed" } })),
    ).toBeNull()
  })
})

describe("readRateLimits", () => {
  const snapshot = {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 62.4, windowDurationMins: 300, resetsAt: 1_700_000 },
    secondary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt: null },
    credits: { hasCredits: true, unlimited: false, balance: "12.40" },
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
  }

  it("reads both windows as fractions of their allowance", () => {
    expect(readRateLimits(snapshot)).toEqual({
      primaryUsed: 0.624,
      primaryWindowMins: 300,
      primaryResetsAt: 1_700_000,
      secondaryUsed: 0.31,
      secondaryWindowMins: 10_080,
      planType: "pro",
      creditBalance: "12.40",
    })
  })

  it("leaves out a window the sparse update did not carry", () => {
    const limits = readRateLimits({ ...snapshot, secondary: null })
    expect(limits).not.toHaveProperty("secondaryUsed")
    expect(limits.primaryUsed).toBeCloseTo(0.624)
  })

  it("clamps a percentage the provider overshot", () => {
    const limits = readRateLimits({
      ...snapshot,
      primary: { usedPercent: 118, windowDurationMins: null, resetsAt: null },
    })
    expect(limits.primaryUsed).toBe(1)
    expect(limits).not.toHaveProperty("primaryWindowMins")
  })

  it("passes on the provider's own word for a limit that was reached", () => {
    expect(
      readRateLimits({ ...snapshot, rateLimitReachedType: "rate_limit_reached" }).reached,
    ).toBe("rate_limit_reached")
  })
})

describe("queueNotice", () => {
  const notice = (id: string) => ({ id, level: "warning" as const, title: id })

  it("holds a warning that arrived with no turn to put it on", () => {
    expect(queueNotice(undefined, notice("a")).map((n) => n.id)).toEqual(["a"])
  })

  it("keeps the newest when a session sat idle through a flood", () => {
    let held = queueNotice(undefined, notice("first"))
    for (let i = 0; i < NOTICE_BACKLOG + 5; i += 1) {
      held = queueNotice(held, notice(`n${i}`))
    }
    expect(held).toHaveLength(NOTICE_BACKLOG)
    expect(held.some((n) => n.id === "first")).toBe(false)
    expect(held.at(-1)?.id).toBe(`n${NOTICE_BACKLOG + 4}`)
  })

  it("lets a repeat of the same warning replace itself rather than pile up", () => {
    const held = queueNotice(queueNotice(undefined, notice("mcp")), notice("mcp"))
    expect(held).toHaveLength(1)
  })
})
