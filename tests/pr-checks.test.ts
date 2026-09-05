import { describe, expect, it, vi } from "vitest"
import type { GitCheck, GitPrStatus, GitPullRequest, SessionMeta } from "../src/shared/types"
import {
  buildFailingChecksPrompt,
  capLogTail,
  failingChecks,
  failingChecksPrompt,
  formatCheckDuration,
  hasFailingChecks,
  LOG_TAIL_CHARS,
  orderChecks,
  prPills,
} from "../src/renderer/src/lib/pr-checks"
import { attentionQueue, needsAttention } from "../src/renderer/src/lib/attention"
import { buildInboxCards } from "../src/renderer/src/lib/inbox"
import {
  buildPaletteEntries,
  SEND_FAILING_CHECKS_KEY,
} from "../src/renderer/src/lib/palette"

function check(patch: Partial<GitCheck> & { name: string }): GitCheck {
  return { state: "success", ...patch }
}

function pr(patch: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number: 7,
    title: "Add checks",
    url: "https://github.com/acme/hub/pull/7",
    branch: "feat/checks",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeable: "UNKNOWN",
    checks: [],
    ...patch,
  }
}

const failingStatus: GitPrStatus = {
  pr: pr({
    checks: [
      check({ name: "CI / lint" }),
      check({
        name: "CI / typecheck",
        state: "failure",
        runId: "1234",
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/1",
      }),
      check({ name: "CI / test", state: "failure", detailsUrl: "https://ci.example/9" }),
      check({ name: "CI / docs", state: "skipped" }),
      check({ name: "CI / build", state: "pending" }),
    ],
  }),
}

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Fix the checks",
    project: "hub",
    provider: "claude",
    cwd: "/repo",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

describe("failingChecks and orderChecks", () => {
  it("lists only the failures", () => {
    expect(failingChecks(failingStatus).map((c) => c.name)).toEqual([
      "CI / typecheck",
      "CI / test",
    ])
    expect(failingChecks({ pr: null })).toEqual([])
    expect(failingChecks(undefined)).toEqual([])
  })

  it("puts failures first, then pending, success and skipped, by name inside a group", () => {
    expect(orderChecks(failingStatus.pr!.checks).map((c) => c.name)).toEqual([
      "CI / test",
      "CI / typecheck",
      "CI / build",
      "CI / lint",
      "CI / docs",
    ])
  })
})

describe("capLogTail", () => {
  it("keeps a short log untouched", () => {
    expect(capLogTail("a\nb\n")).toBe("a\nb")
  })

  it("keeps the tail on whole lines and marks the cut", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`)
    const out = capLogTail(lines.join("\n"))
    expect(out.length).toBeLessThanOrEqual(LOG_TAIL_CHARS + 1)
    expect(out.startsWith("…line ")).toBe(true)
    expect(out.endsWith(lines[lines.length - 1])).toBe(true)
  })
})

describe("buildFailingChecksPrompt", () => {
  it("returns null with nothing failing", () => {
    expect(buildFailingChecksPrompt("main", [])).toBeNull()
  })

  it("names the check and branch, then asks for the fix", () => {
    expect(
      buildFailingChecksPrompt("feat/checks", [
        { name: "CI / typecheck", log: "src/a.ts(1,1): error TS2322\n" },
      ]),
    ).toBe(
      "CI check CI / typecheck failed on feat/checks:\nsrc/a.ts(1,1): error TS2322\nFix it and re-run the relevant tests.",
    )
  })

  it("folds several failures into one prompt", () => {
    const prompt = buildFailingChecksPrompt("feat/checks", [
      { name: "a", log: "log a" },
      { name: "b", log: "log b" },
    ])
    expect(prompt).toBe(
      "CI check a failed on feat/checks:\nlog a\n\nCI check b failed on feat/checks:\nlog b\nFix it and re-run the relevant tests.",
    )
  })
})

describe("failingChecksPrompt", () => {
  it("fetches a log per run id and points at the details page otherwise", async () => {
    const fetchLog = vi.fn(async (_cwd: string, runId: string) => `log for ${runId}`)
    const prompt = await failingChecksPrompt("/repo", failingStatus, fetchLog)
    expect(fetchLog).toHaveBeenCalledWith("/repo", "1234")
    expect(prompt).toBe(
      [
        "CI check CI / typecheck failed on feat/checks:\nlog for 1234",
        "CI check CI / test failed on feat/checks:\n(no log available; see https://ci.example/9)",
      ].join("\n\n") + "\nFix it and re-run the relevant tests.",
    )
  })

  it("survives a log fetch that fails", async () => {
    const fetchLog = vi.fn(async () => {
      throw new Error("gh exploded")
    })
    const prompt = await failingChecksPrompt("/repo", failingStatus, fetchLog)
    expect(prompt).toContain(
      "CI check CI / typecheck failed on feat/checks:\n(no log available; see https://github.com/acme/hub/actions/runs/1234/job/1)",
    )
  })

  it("yields nothing without a PR or without failures", async () => {
    const fetchLog = vi.fn(async () => "")
    expect(await failingChecksPrompt("/repo", { pr: null }, fetchLog)).toBeNull()
    expect(await failingChecksPrompt("/repo", { pr: pr() }, fetchLog)).toBeNull()
    expect(fetchLog).not.toHaveBeenCalled()
  })
})

describe("formatCheckDuration", () => {
  it("prints seconds under a minute and minutes above", () => {
    expect(formatCheckDuration(4200)).toBe("4s")
    expect(formatCheckDuration(60_000)).toBe("1m")
    expect(formatCheckDuration(61_000)).toBe("1m 1s")
    expect(formatCheckDuration(754_000)).toBe("12m 34s")
  })
})

describe("prPills", () => {
  it("shows draft, review and merge state", () => {
    expect(
      prPills(pr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE" })),
    ).toEqual([
      { label: "draft", tone: "soft" },
      { label: "review required", tone: "warn" },
      { label: "mergeable", tone: "soft" },
    ])
  })

  it("flags conflicts and requested changes, and reads merged and closed", () => {
    expect(
      prPills(pr({ reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" })),
    ).toEqual([
      { label: "open", tone: "ok" },
      { label: "changes requested", tone: "danger" },
      { label: "conflicts", tone: "danger" },
    ])
    expect(prPills(pr({ state: "MERGED", reviewDecision: "APPROVED" }))).toEqual([
      { label: "merged", tone: "soft" },
      { label: "approved", tone: "ok" },
    ])
    expect(prPills(pr({ state: "CLOSED" }))).toEqual([{ label: "closed", tone: "danger" }])
  })
})

describe("attention on failing checks", () => {
  const byCwd = { "/repo": failingStatus }

  it("counts a session whose branch has a failing check as needing attention", () => {
    expect(hasFailingChecks(session(), byCwd)).toBe(true)
    expect(needsAttention(session(), {}, byCwd)).toBe(true)
    expect(needsAttention(session(), {})).toBe(false)
    expect(attentionQueue([session()], {}, byCwd).map((s) => s.id)).toEqual(["s1"])
  })

  it("ignores other folders, archived and settled sessions and green PRs", () => {
    expect(hasFailingChecks(session({ cwd: "/elsewhere" }), byCwd)).toBe(false)
    expect(hasFailingChecks(session({ archived: true }), byCwd)).toBe(false)
    expect(hasFailingChecks(session({ settledAt: 5 }), byCwd)).toBe(false)
    expect(hasFailingChecks(session(), { "/repo": { pr: pr() } })).toBe(false)
  })

  it("keeps waiting sessions ahead of idle ones with failing checks", () => {
    const waiting = session({ id: "w", cwd: "/other", status: "waiting_input" })
    const queue = attentionQueue([session(), waiting], {}, byCwd)
    expect(queue.map((s) => s.id)).toEqual(["w", "s1"])
  })
})

describe("inbox card for failing checks", () => {
  it("adds one card per session naming the failing checks", () => {
    const cards = buildInboxCards([session({ activityAt: 40 })], [], [], {
      "/repo": failingStatus,
    })
    expect(cards).toEqual([
      {
        id: "checks:s1",
        kind: "checks",
        sessionId: "s1",
        requestId: null,
        title: "Fix the checks",
        project: "hub",
        at: 40,
        body: "2 checks failing · CI / typecheck, CI / test",
      },
    ])
  })

  it("adds nothing for a green or missing PR", () => {
    expect(buildInboxCards([session()], [], [], { "/repo": { pr: pr() } })).toEqual([])
    expect(buildInboxCards([session()], [], [])).toEqual([])
  })
})

describe("palette entry for failing checks", () => {
  it("offers the command only when the active session has failures", () => {
    const withFailures = buildPaletteEntries([session()], "", 0, 0, 2)
    const keys = withFailures.map((e) => (e.kind === "command" ? e.key : e.session.id))
    expect(keys).toContain(SEND_FAILING_CHECKS_KEY)
    const entry = withFailures.find(
      (e) => e.kind === "command" && e.key === SEND_FAILING_CHECKS_KEY,
    )
    expect(entry).toMatchObject({ label: "Send failing checks to agent", hint: "⌘⇧X" })
    const without = buildPaletteEntries([session()], "", 0, 0, 0)
    expect(without.map((e) => (e.kind === "command" ? e.key : e.session.id))).not.toContain(
      SEND_FAILING_CHECKS_KEY,
    )
  })

  it("is found by typing about failing checks", () => {
    const entries = buildPaletteEntries([session()], "failing checks", 0, 0, 1)
    expect(entries[0]).toMatchObject({ kind: "command", key: SEND_FAILING_CHECKS_KEY })
  })
})
