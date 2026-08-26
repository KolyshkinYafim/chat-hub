import { describe, expect, it } from "vitest"
import type { Project, SessionMeta } from "@shared/types"
import {
  buildProjectPicks,
  filterPicks,
  moveHighlight,
  preferredAgent,
  recallFor,
  typedPathPick,
} from "@renderer/lib/new-session-picks"

const T = 1_700_000_000_000

function session(over: Partial<SessionMeta> & { id: string; cwd: string }): SessionMeta {
  return {
    title: over.id,
    project: over.project ?? "p",
    provider: "claude",
    status: "idle",
    createdAt: T - 1000,
    updatedAt: T,
    ...over,
  } as SessionMeta
}

const projects: Project[] = [
  { id: "p1", name: "Orbit API", cwd: "/code/orbit-api", createdAt: T - 50_000 },
  { id: "p2", name: "aurora-shop", cwd: "/code/aurora-shop", createdAt: T - 40_000 },
]

describe("buildProjectPicks", () => {
  it("offers pinned projects even before any session ran in them", () => {
    // Nothing has been used, so the day each was pinned is the only order there is.
    const picks = buildProjectPicks(projects, [])
    expect(picks.map((p) => p.cwd)).toEqual(["/code/aurora-shop", "/code/orbit-api"])
    expect(picks.every((p) => p.pinned)).toBe(true)
    expect(picks.every((p) => p.sessions === 0)).toBe(true)
  })

  it("keeps the name the owner pinned, not the session's group name", () => {
    const picks = buildProjectPicks(projects, [
      session({ id: "a", cwd: "/code/orbit-api", project: "orbit-api" }),
    ])
    expect(picks.find((p) => p.cwd === "/code/orbit-api")?.name).toBe("Orbit API")
  })

  it("adds folders that only past sessions know about", () => {
    const picks = buildProjectPicks(projects, [
      session({ id: "a", cwd: "/code/scratch", project: "scratch", updatedAt: T }),
    ])
    const scratch = picks.find((p) => p.cwd === "/code/scratch")
    expect(scratch).toMatchObject({ name: "scratch", pinned: false, sessions: 1 })
  })

  it("orders by recency, newest first", () => {
    const picks = buildProjectPicks(projects, [
      session({ id: "a", cwd: "/code/aurora-shop", updatedAt: T }),
      session({ id: "b", cwd: "/code/orbit-api", updatedAt: T - 20_000 }),
    ])
    expect(picks.map((p) => p.cwd)).toEqual(["/code/aurora-shop", "/code/orbit-api"])
  })

  it("puts the folder you are looking at first regardless of recency", () => {
    const picks = buildProjectPicks(
      projects,
      [session({ id: "a", cwd: "/code/aurora-shop", updatedAt: T })],
      "/code/orbit-api",
    )
    expect(picks[0].cwd).toBe("/code/orbit-api")
  })

  it("offers a hint folder the Hub has never seen", () => {
    const picks = buildProjectPicks([], [], "/code/brand-new")
    expect(picks).toHaveLength(1)
    expect(picks[0]).toMatchObject({ cwd: "/code/brand-new", name: "brand-new", sessions: 0 })
  })

  it("groups an isolated session under its repository, not its worktree", () => {
    const picks = buildProjectPicks(projects, [
      session({
        id: "a",
        cwd: "/code/orbit-api/.worktrees/feature",
        baseCwd: "/code/orbit-api",
        project: "orbit-api",
      }),
    ])
    expect(picks.map((p) => p.cwd)).not.toContain("/code/orbit-api/.worktrees/feature")
    expect(picks.find((p) => p.cwd === "/code/orbit-api")?.sessions).toBe(1)
  })

  it("treats a trailing slash as the same folder", () => {
    const picks = buildProjectPicks(
      [{ id: "p", name: "x", cwd: "/code/x/", createdAt: T }],
      [session({ id: "a", cwd: "/code/x" })],
    )
    expect(picks).toHaveLength(1)
    expect(picks[0].sessions).toBe(1)
  })

  it("counts every session in a folder", () => {
    const picks = buildProjectPicks(projects, [
      session({ id: "a", cwd: "/code/orbit-api", updatedAt: T }),
      session({ id: "b", cwd: "/code/orbit-api", updatedAt: T - 1 }),
      session({ id: "c", cwd: "/code/orbit-api", updatedAt: T - 2 }),
    ])
    expect(picks.find((p) => p.cwd === "/code/orbit-api")?.sessions).toBe(3)
  })
})

describe("recallFor", () => {
  const picks = buildProjectPicks(projects, [
    session({
      id: "old",
      cwd: "/code/orbit-api",
      provider: "grok",
      model: "grok-4",
      updatedAt: T - 90_000,
    }),
    session({
      id: "new",
      cwd: "/code/orbit-api",
      provider: "codex",
      instanceId: "codex-work",
      model: "gpt-5",
      updatedAt: T,
    }),
  ])

  it("remembers what the newest session in the folder ran on", () => {
    expect(recallFor(picks, "/code/orbit-api")).toEqual({
      instanceId: "codex-work",
      model: "gpt-5",
    })
  })

  it("falls back to the provider id when a session has no instance", () => {
    const one = buildProjectPicks([], [session({ id: "a", cwd: "/code/z", provider: "grok" })])
    expect(recallFor(one, "/code/z").instanceId).toBe("grok")
  })

  it("has nothing to remember for a folder with no history", () => {
    expect(recallFor(picks, "/code/aurora-shop")).toEqual({
      instanceId: undefined,
      model: undefined,
    })
  })
})

describe("filterPicks", () => {
  const picks = buildProjectPicks(projects, [
    session({ id: "a", cwd: "/work/proxy-flash-admin", project: "proxy-flash-admin" }),
  ])

  it("returns everything for an empty query", () => {
    expect(filterPicks(picks, "  ")).toHaveLength(3)
  })

  it("matches on the project name", () => {
    expect(filterPicks(picks, "aur").map((p) => p.name)).toEqual(["aurora-shop"])
  })

  it("matches on a fragment of the path", () => {
    expect(filterPicks(picks, "work/pro").map((p) => p.name)).toEqual([
      "proxy-flash-admin",
    ])
  })

  it("matches an acronym the way the switcher does", () => {
    expect(filterPicks(picks, "pfa")[0].name).toBe("proxy-flash-admin")
  })

  it("drops rows that match nothing", () => {
    expect(filterPicks(picks, "zzzz")).toEqual([])
  })
})

describe("typedPathPick", () => {
  const picks = buildProjectPicks(projects, [])

  it("offers a pasted path the Hub has never seen", () => {
    expect(typedPathPick(picks, "/code/somewhere-else")).toMatchObject({
      cwd: "/code/somewhere-else",
      name: "somewhere-else",
      sessions: 0,
    })
  })

  it("stays quiet when the path is already a pick", () => {
    expect(typedPathPick(picks, "/code/orbit-api")).toBeNull()
    expect(typedPathPick(picks, "/code/orbit-api/")).toBeNull()
  })

  it("stays quiet for a search term", () => {
    expect(typedPathPick(picks, "orbit")).toBeNull()
    expect(typedPathPick(picks, "")).toBeNull()
    expect(typedPathPick(picks, "/")).toBeNull()
  })
})

describe("moveHighlight", () => {
  it("wraps at both ends", () => {
    expect(moveHighlight(3, 0, 1)).toBe(1)
    expect(moveHighlight(3, 2, 1)).toBe(0)
    expect(moveHighlight(3, 0, -1)).toBe(2)
  })

  it("has nowhere to go in an empty list", () => {
    expect(moveHighlight(0, 0, 1)).toBe(0)
    expect(moveHighlight(0, 0, -1)).toBe(0)
  })
})

describe("preferredAgent", () => {
  const available = [{ instanceId: "claude" }, { instanceId: "codex-work" }]

  it("uses what the folder used last when it is still installed", () => {
    expect(preferredAgent("codex-work", available, "claude")).toBe("codex-work")
  })

  it("falls back to the hub default when the remembered agent is gone", () => {
    expect(preferredAgent("grok", available, "claude")).toBe("claude")
  })

  it("falls back to the first agent when even the default is gone", () => {
    expect(preferredAgent(undefined, available, "grok")).toBe("claude")
  })

  it("keeps the default when nothing is available to choose from", () => {
    expect(preferredAgent(undefined, [], "claude")).toBe("claude")
  })
})
