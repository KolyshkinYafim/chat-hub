// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HubEvent } from "../src/shared/types"
import { SourceControl } from "../src/renderer/src/components/SourceControl"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  container?.remove()
  localStorage.clear()
  vi.useRealTimers()
})

async function mount() {
  const listeners = new Set<(event: HubEvent) => void>()
  const stopWatching = vi.fn()
  const watchGitPr = vi.fn(() => stopWatching)
  const gitPrStatus = vi.fn(async () => ({ pr: null }))
  const gitDiff = vi.fn(async () => "@@ -1 +1 @@\n-old\n+new\n")
  const gitStage = vi.fn(async () => ({ root: "/workspace/repo", branch: "main", ahead: 0, behind: 0, files: [] }))
  window.chatHub = {
    gitStatus: async () => ({ root: "/workspace/repo", branch: "main", ahead: 0, behind: 0,
      files: ["one.ts", "two.ts", "three.ts"].map((path) => ({ path, index: " ", work: "M" })),
    }),
    gitRepositories: async () => [{ root: "/workspace/repo", name: "repo", branch: "main", dirty: true }],
    gitBranches: async () => ({ branches: ["main"], current: "main" }),
    gitWorktrees: async () => [],
    gitHunkSummary: async () => ({}),
    gitPrStatuses: async () => ({ "/workspace/repo": { pr: null }, "/workspace": { pr: null } }),
    gitPrStatus, gitDiff, gitStage, watchGitPr,
    onHubEvent: (listener: (event: HubEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as unknown as typeof window.chatHub
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(SourceControl, {
      cwd: "/workspace", sessionId: "test", refreshKey: 0,
      onSend: async () => {}, onClose: () => {}, onChanged: () => {},
    }))
  })
  return { listeners, gitPrStatus, gitDiff, gitStage, watchGitPr, stopWatching }
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent === label || item.getAttribute("aria-label") === label,
  )
  expect(button).toBeTruthy()
  await act(async () => { button!.click() })
}

describe("source control", () => {
  it("focuses the diff, navigates files, and exits with Escape", async () => {
    const { gitDiff } = await mount()
    await click("Focus diff")
    expect(container.querySelector(".scm-focused")).toBeTruthy()
    expect(container.querySelector(".scm-diff-toolbar")?.textContent).toContain("1/3")
    await click("Next file")
    expect(container.querySelector(".scm-diff-toolbar")?.textContent).toContain("2/3")
    expect(container.querySelector(".scm-diff-file")?.textContent).toContain("two.ts")
    expect(gitDiff).toHaveBeenLastCalledWith("/workspace/repo", "two.ts", false, false)
    await act(async () => {
      container.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(container.querySelector(".scm-focused")).toBeNull()
    expect(container.querySelector(".scm-diff-file")?.textContent).toContain("two.ts")
  })

  it("uses cached PR status and live events without a second polling timer", async () => {
    vi.useFakeTimers()
    const { listeners, gitPrStatus, watchGitPr, stopWatching } = await mount()
    expect(container.textContent).toContain("No pull request for this branch")
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(gitPrStatus).not.toHaveBeenCalled()
    await act(async () => {
      for (const listener of listeners) listener({ type: "git.pr", cwd: "/workspace/repo", status: { pr: null, unavailable: "unauthenticated" } })
    })
    expect(container.textContent).toContain("Run gh auth login")
    await act(async () => { root?.unmount() })
    root = undefined
    expect(listeners.size).toBe(0)
    expect(watchGitPr).toHaveBeenCalledWith("/workspace/repo")
    expect(stopWatching).toHaveBeenCalledTimes(watchGitPr.mock.calls.length)
  })

  it("stages in the repository selected from the workspace", async () => {
    const { gitStage } = await mount()
    await click("Stage all")
    expect(gitStage).toHaveBeenCalledWith("/workspace/repo", ["one.ts", "two.ts", "three.ts"])
  })
})
