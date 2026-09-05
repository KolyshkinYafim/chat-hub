import { describe, expect, it, vi } from "vitest"
import type { GitPrStatus } from "../src/shared/types"
import {
  LOG_TAIL_LINES,
  parsePrView,
  prStatusFromFailure,
  trimLogTail,
} from "../src/main/git"
import { PrStatusWatcher } from "../src/main/pr-status"

function prView(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: "Verify JWT claims",
    url: "https://github.com/acme/hub/pull/42",
    headRefName: "fix/jwt-claims",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "typecheck",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-09-05T10:00:00Z",
        completedAt: "2026-09-05T10:01:01Z",
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/5678",
      },
      {
        __typename: "CheckRun",
        name: "lint",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-09-05T10:00:00Z",
        completedAt: "2026-09-05T10:00:42Z",
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/9999",
      },
      {
        __typename: "CheckRun",
        name: "test",
        workflowName: "CI",
        status: "IN_PROGRESS",
        conclusion: "",
        startedAt: "2026-09-05T10:00:00Z",
        completedAt: "0001-01-01T00:00:00Z",
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/1111",
      },
      {
        __typename: "CheckRun",
        name: "docs",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SKIPPED",
      },
      {
        __typename: "StatusContext",
        context: "ci/circleci: build",
        state: "SUCCESS",
        targetUrl: "https://circleci.com/gh/acme/hub/77",
      },
    ],
    ...patch,
  })
}

describe("parsePrView", () => {
  it("reads an open PR with its checks, run ids and durations", () => {
    const pr = parsePrView(prView())
    expect(pr).toMatchObject({
      number: 42,
      title: "Verify JWT claims",
      url: "https://github.com/acme/hub/pull/42",
      branch: "fix/jwt-claims",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
    })
    expect(pr.checks).toEqual([
      {
        name: "CI / typecheck",
        state: "failure",
        durationMs: 61_000,
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/5678",
        runId: "1234",
      },
      {
        name: "CI / lint",
        state: "success",
        durationMs: 42_000,
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/9999",
        runId: "1234",
      },
      {
        name: "CI / test",
        state: "pending",
        detailsUrl: "https://github.com/acme/hub/actions/runs/1234/job/1111",
        runId: "1234",
      },
      { name: "CI / docs", state: "skipped" },
      {
        name: "ci/circleci: build",
        state: "success",
        detailsUrl: "https://circleci.com/gh/acme/hub/77",
      },
    ])
  })

  it("keeps a draft PR marked as a draft", () => {
    const pr = parsePrView(prView({ isDraft: true, reviewDecision: "" }))
    expect(pr.isDraft).toBe(true)
    expect(pr.reviewDecision).toBeNull()
  })

  it("reads a merged PR with an approval and no checks", () => {
    const pr = parsePrView(
      prView({
        state: "MERGED",
        reviewDecision: "APPROVED",
        mergeable: "UNKNOWN",
        statusCheckRollup: [],
      }),
    )
    expect(pr.state).toBe("MERGED")
    expect(pr.reviewDecision).toBe("APPROVED")
    expect(pr.mergeable).toBe("UNKNOWN")
    expect(pr.checks).toEqual([])
  })

  it("maps cancelled and timed-out runs to failures and pending statuses to pending", () => {
    const pr = parsePrView(
      prView({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "CANCELLED" },
          { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "TIMED_OUT" },
          { __typename: "CheckRun", name: "c", status: "QUEUED" },
          { __typename: "StatusContext", context: "d", state: "PENDING" },
          { __typename: "StatusContext", context: "e", state: "ERROR" },
        ],
      }),
    )
    expect(pr.checks.map((c) => c.state)).toEqual([
      "failure",
      "failure",
      "pending",
      "pending",
      "failure",
    ])
  })

  it("falls back to sane values for unknown enum strings", () => {
    const pr = parsePrView(
      prView({ state: "WEIRD", mergeable: "MAYBE", reviewDecision: "LATER" }),
    )
    expect(pr.state).toBe("OPEN")
    expect(pr.mergeable).toBe("UNKNOWN")
    expect(pr.reviewDecision).toBeNull()
  })

  it("refuses a payload without a pull request", () => {
    expect(() => parsePrView("{}")).toThrow(/no pull request/)
    expect(() => parsePrView("not json")).toThrow()
  })
})

describe("prStatusFromFailure", () => {
  it("reports a missing gh binary", () => {
    expect(prStatusFromFailure({ code: "ENOENT", message: "spawn gh ENOENT" })).toEqual({
      pr: null,
      unavailable: "missing",
    })
  })

  it("reports a gh that is not signed in", () => {
    const stderr =
      "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n"
    expect(prStatusFromFailure({ code: "1", stderr })).toEqual({
      pr: null,
      unavailable: "unauthenticated",
    })
    expect(prStatusFromFailure({ stderr: "HTTP 401: Bad credentials" })).toEqual({
      pr: null,
      unavailable: "unauthenticated",
    })
  })

  it("treats a branch without a PR as plain no-PR", () => {
    expect(
      prStatusFromFailure({
        stderr: 'no pull requests found for branch "feat/checks-tab"\n',
      }),
    ).toEqual({ pr: null })
    expect(prStatusFromFailure({ stderr: "no git remotes found" })).toEqual({
      pr: null,
    })
  })

  it("keeps every other failure distinguishable from no-PR", () => {
    expect(prStatusFromFailure({ stderr: "error connecting to api.github.com" })).toEqual({
      pr: null,
      unavailable: "error",
    })
  })
})

describe("trimLogTail", () => {
  it("strips ANSI colour and keeps the last lines", () => {
    const lines = Array.from({ length: LOG_TAIL_LINES + 25 }, (_, i) =>
      i % 2 === 0 ? `\x1b[32mline ${i}\x1b[0m` : `line ${i}`,
    )
    const out = trimLogTail(lines.join("\n") + "\n\n")
    const kept = out.split("\n")
    expect(kept).toHaveLength(LOG_TAIL_LINES)
    expect(kept[0]).toBe("line 25")
    expect(kept[kept.length - 1]).toBe(`line ${LOG_TAIL_LINES + 24}`)
    expect(out).not.toContain("\x1b")
  })

  it("drops carriage returns and trailing blank lines", () => {
    expect(trimLogTail("a\r\nb\r\n\r\n")).toBe("a\nb")
    expect(trimLogTail("only", 1)).toBe("only")
    expect(trimLogTail("a\nb\nc", 2)).toBe("b\nc")
  })
})

describe("PrStatusWatcher", () => {
  const open: GitPrStatus = {
    pr: {
      number: 1,
      title: "t",
      url: "u",
      branch: "b",
      state: "OPEN",
      isDraft: false,
      reviewDecision: null,
      mergeable: "UNKNOWN",
      checks: [],
    },
  }

  function harness(fetch: (cwd: string) => Promise<GitPrStatus>, cwds: string[]) {
    const emitted: [string, GitPrStatus][] = []
    const watcher = new PrStatusWatcher({
      fetch,
      liveCwds: () => cwds,
      emit: (cwd, status) => emitted.push([cwd, status]),
      intervalMs: 1000,
    })
    return { watcher, emitted }
  }

  it("keeps an acknowledgement until the failing set changes", async () => {
    const failing = (...names: string[]): GitPrStatus => ({
      pr: {
        ...open.pr!,
        checks: names.map((name) => ({ name, state: "failure" as const })),
      },
    })
    let current = failing("lint")
    const { watcher, emitted } = harness(async () => current, [])
    expect(watcher.acknowledge("/r")).toBeNull()
    await watcher.refresh("/r")
    expect(watcher.acknowledge("/r")?.acknowledged).toBe(true)
    expect(watcher.snapshot()["/r"].acknowledged).toBe(true)
    expect(emitted.at(-1)?.[1].acknowledged).toBe(true)
    expect((await watcher.refresh("/r")).acknowledged).toBe(true)
    current = failing("lint", "test")
    expect((await watcher.refresh("/r")).acknowledged).toBeUndefined()
    current = failing("lint")
    expect((await watcher.refresh("/r")).acknowledged).toBeUndefined()
    watcher.acknowledge("/r")
    current = open
    expect((await watcher.refresh("/r")).acknowledged).toBeUndefined()
    expect(watcher.acknowledge("/r")?.acknowledged).toBeUndefined()
  })

  it("caches and emits every refresh, deduplicating concurrent ones", async () => {
    const fetch = vi.fn(async () => open)
    const { watcher, emitted } = harness(fetch, [])
    const [a, b] = await Promise.all([watcher.refresh("/r"), watcher.refresh("/r")])
    expect(a).toBe(open)
    expect(b).toBe(open)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([["/r", open]])
    expect(watcher.snapshot()).toEqual({ "/r": open })
  })

  it("polls the live cwds on an interval and drops stale cache entries", async () => {
    vi.useFakeTimers()
    try {
      const cwds = ["/a", "/b"]
      const fetch = vi.fn(async () => open)
      const { watcher } = harness(fetch, cwds)
      await watcher.refresh("/gone")
      watcher.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch.mock.calls.map(([cwd]) => cwd)).toEqual(["/gone", "/a", "/b"])
      expect(watcher.snapshot()).toEqual({ "/a": open, "/b": open })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetch).toHaveBeenCalledTimes(5)
      watcher.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetch).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops polling once gh is missing, but an explicit refresh still probes", async () => {
    vi.useFakeTimers()
    try {
      const missing: GitPrStatus = { pr: null, unavailable: "missing" }
      const fetch = vi.fn(async () => missing)
      const { watcher } = harness(fetch, ["/a", "/b"])
      watcher.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetch).toHaveBeenCalledTimes(1)
      fetch.mockResolvedValue(open)
      await watcher.refresh("/a")
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetch).toHaveBeenCalledTimes(4)
      watcher.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("surfaces a rejected fetch to the caller and keeps polling afterwards", async () => {
    const fetch = vi
      .fn<(cwd: string) => Promise<GitPrStatus>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(open)
    const { watcher, emitted } = harness(fetch, ["/a"])
    await expect(watcher.refresh("/a")).rejects.toThrow("boom")
    await watcher.tick()
    expect(emitted).toEqual([["/a", open]])
  })
})
