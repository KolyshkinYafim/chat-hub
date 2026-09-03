import { describe, expect, it } from "vitest"

import {
  buildInboxCards,
  inboxOneLine,
  inboxPrimaryAction,
  resolveInboxCursor,
} from "../src/renderer/src/lib/inbox"
import type {
  AgentInputQuestion,
  AgentInputRequestInfo,
  PermissionRequestInfo,
  SessionMeta,
} from "../src/shared/types"

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Fix the flaky test",
    project: "hub",
    provider: "claude",
    cwd: "/Users/dev/hub",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

function permission(
  patch: Partial<PermissionRequestInfo> = {},
): PermissionRequestInfo {
  return {
    requestId: "p1",
    sessionId: "s1",
    agentSessionId: "claude-1",
    source: "claude",
    summary: "Read src/lib/inbox.ts",
    toolName: "Read",
    createdAt: 10,
    ...patch,
  }
}

function question(
  patch: Partial<AgentInputRequestInfo> = {},
  questions: AgentInputQuestion[] = [
    { id: "q1", header: "Lockfile", prompt: "Which lockfile should CI use?" },
  ],
): AgentInputRequestInfo {
  return {
    requestId: "r1",
    sessionId: "s1",
    source: "codex",
    questions,
    createdAt: 20,
    ...patch,
  }
}

describe("inboxOneLine", () => {
  it("collapses whitespace and leaves a short line alone", () => {
    expect(inboxOneLine("  Which\nlockfile  should  CI use?  ")).toBe(
      "Which lockfile should CI use?",
    )
  })

  it("truncates with an ellipsis at the limit", () => {
    const line = inboxOneLine("abcdefghij", 8)
    expect(line).toBe("abcdefg…")
    expect(line.length).toBe(8)
  })
})

describe("inboxPrimaryAction", () => {
  it("allows a permission in place and opens the rest", () => {
    expect(inboxPrimaryAction("permission")).toBe("allow")
    expect(inboxPrimaryAction("question")).toBe("open")
    expect(inboxPrimaryAction("failed")).toBe("open")
  })
})

describe("resolveInboxCursor", () => {
  const keys = ["a", "b", "c"]

  it("starts on the first card", () => {
    expect(resolveInboxCursor(keys, { key: null, index: 0 })).toBe(0)
  })

  it("follows its key when cards shift around it", () => {
    expect(resolveInboxCursor(keys, { key: "b", index: 0 })).toBe(1)
    expect(resolveInboxCursor(["x", "b"], { key: "b", index: 1 })).toBe(1)
  })

  it("keeps the remembered index when the key is gone", () => {
    expect(resolveInboxCursor(keys, { key: "gone", index: 5 })).toBe(2)
    expect(resolveInboxCursor(keys, { key: "gone", index: 1 })).toBe(1)
  })

  it("stays at zero on an empty list", () => {
    expect(resolveInboxCursor([], { key: "a", index: 4 })).toBe(0)
  })
})

describe("buildInboxCards", () => {
  it("builds permission, question and failed cards", () => {
    const waiting = session({ id: "s1", status: "waiting_input", updatedAt: 10 })
    const errored = session({
      id: "s2",
      title: "Webhook retries",
      project: "pay",
      status: "error",
      updatedAt: 5,
    })
    const cards = buildInboxCards(
      [waiting, errored],
      [permission({ createdAt: 40 })],
      [question({ sessionId: "s1", createdAt: 30 })],
    )
    expect(cards.map((c) => c.kind)).toEqual([
      "permission",
      "question",
      "failed",
    ])
    expect(cards[0]).toMatchObject({
      id: "permission:p1",
      sessionId: "s1",
      requestId: "p1",
      title: waiting.title,
      project: waiting.project,
      body: "Read · Read src/lib/inbox.ts",
    })
    expect(cards[1]).toMatchObject({
      id: "question:r1",
      kind: "question",
      body: "Which lockfile should CI use?",
    })
    expect(cards[2]).toMatchObject({
      id: "failed:s2",
      kind: "failed",
      title: "Webhook retries",
      project: "pay",
      body: "The agent stopped with an error",
      requestId: null,
    })
  })

  it("orders newest first and breaks ties by id", () => {
    const a = session({ id: "s-a", status: "error", updatedAt: 7 })
    const b = session({ id: "s-b", status: "error", updatedAt: 7 })
    const newer = permission({
      requestId: "p-new",
      sessionId: "s-a",
      createdAt: 50,
    })
    const older = question({
      requestId: "r-old",
      sessionId: "s-b",
      createdAt: 3,
    })
    const cards = buildInboxCards([a, b], [newer], [older])
    expect(cards.map((c) => c.id)).toEqual([
      "permission:p-new",
      "failed:s-a",
      "failed:s-b",
      "question:r-old",
    ])
  })

  it("prefers activityAt over updatedAt for failed sessions", () => {
    const renamed = session({
      id: "renamed",
      status: "error",
      activityAt: 5,
      updatedAt: 90,
    })
    const recent = session({
      id: "recent",
      status: "error",
      activityAt: 20,
      updatedAt: 20,
    })
    const cards = buildInboxCards([renamed, recent], [], [])
    expect(cards.map((c) => c.sessionId)).toEqual(["recent", "renamed"])
  })

  it("keeps a permission whose session is missing", () => {
    const cards = buildInboxCards(
      [],
      [permission({ sessionId: null, summary: "Bash ls" })],
      [],
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      kind: "permission",
      sessionId: null,
      title: "Unknown session",
      project: "—",
      body: "Read · Bash ls",
    })
  })

  it("drops settled and archived failures via needsAction", () => {
    const cards = buildInboxCards(
      [
        session({ id: "a", status: "error", settledAt: 9 }),
        session({ id: "b", status: "error", archived: true }),
        session({ id: "c", status: "idle" }),
        session({ id: "d", status: "waiting_input" }),
      ],
      [],
      [],
    )
    expect(cards).toEqual([])
  })

  it("does not invent a card for a waiting session that already has a request", () => {
    const waiting = session({ id: "s1", status: "waiting_input" })
    const cards = buildInboxCards(
      [waiting],
      [permission({ createdAt: 1 })],
      [],
    )
    expect(cards.map((c) => c.kind)).toEqual(["permission"])
  })

  it("prefixes a one-line body when a request holds several questions", () => {
    const cards = buildInboxCards(
      [session()],
      [],
      [
        question({ createdAt: 1 }, [
          { id: "q1", header: "", prompt: "Pick a lockfile" },
          { id: "q2", header: "", prompt: "And a registry" },
        ]),
      ],
    )
    expect(cards[0]?.body).toBe("2 questions · Pick a lockfile")
  })
})
