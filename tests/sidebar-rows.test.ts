import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import {
  belongsInFavoritesGroup,
  belongsInNeedsYouGroup,
  belongsInProjectGroups,
  belongsInSettledGroup,
  partitionSidebarRows,
  sessionBucket,
  type RowContext,
  type RowHold,
} from "../src/renderer/src/lib/sidebar-rows"

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Clickup task audit",
    project: "NSFW",
    provider: "claude",
    cwd: "/Users/dev/NSFW",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

const idle: RowContext = {
  searching: false,
  statusFiltered: false,
  activeId: null,
  seen: {},
}

describe("project groups", () => {
  it("lists a live session", () => {
    expect(belongsInProjectGroups(session(), idle)).toBe(true)
  })

  it("drops a settled session so the groups stay a list of live work", () => {
    expect(belongsInProjectGroups(session({ settledAt: 5 }), idle)).toBe(false)
  })

  it("drops a favourite, which the group above already lists", () => {
    expect(belongsInProjectGroups(session({ favorite: true }), idle)).toBe(false)
  })

  it("drops a session that needs attention, which Needs you lists", () => {
    expect(
      belongsInProjectGroups(session({ status: "waiting_input" }), idle),
    ).toBe(false)
  })

  it("keeps a done session the reader has already seen", () => {
    expect(
      belongsInProjectGroups(session({ status: "done", updatedAt: 7 }), {
        ...idle,
        seen: { s1: 7 },
      }),
    ).toBe(true)
  })

  it("drops the open session when it is a favourite, not to lose it twice", () => {
    const open = session({ id: "s9", favorite: true, settledAt: 5 })
    expect(
      belongsInProjectGroups(open, { ...idle, activeId: "s9" }),
    ).toBe(false)
  })

  it("keeps the open session listed even once it settles", () => {
    const open = session({ id: "s9", settledAt: 5 })
    expect(
      belongsInProjectGroups(open, { ...idle, activeId: "s9" }),
    ).toBe(true)
  })

  it("never lists an archived session, open or not", () => {
    const gone = session({ id: "s9", archived: true, settledAt: 5 })
    expect(
      belongsInProjectGroups(gone, {
        ...idle,
        searching: true,
        activeId: "s9",
      }),
    ).toBe(false)
  })

  it("lists everything unarchived while a query is typed", () => {
    expect(
      belongsInProjectGroups(session({ settledAt: 5 }), {
        ...idle,
        searching: true,
      }),
    ).toBe(true)
  })
})

describe("needs-you group", () => {
  it("holds waiting and errored sessions", () => {
    expect(
      belongsInNeedsYouGroup(session({ status: "waiting_input" }), idle),
    ).toBe(true)
    expect(belongsInNeedsYouGroup(session({ status: "error" }), idle)).toBe(
      true,
    )
  })

  it("holds a done session only until it has been seen", () => {
    const fresh = session({ status: "done", updatedAt: 7 })
    expect(belongsInNeedsYouGroup(fresh, idle)).toBe(true)
    expect(belongsInNeedsYouGroup(fresh, { ...idle, seen: { s1: 7 } })).toBe(
      false,
    )
  })

  it("lifts a needy favourite out of Favorites", () => {
    const needy = session({ status: "error", favorite: true })
    expect(belongsInNeedsYouGroup(needy, idle)).toBe(true)
    expect(belongsInFavoritesGroup(needy, idle)).toBe(false)
  })

  it("lets settling or archiving put a needy session away", () => {
    expect(
      belongsInNeedsYouGroup(session({ status: "error", settledAt: 5 }), idle),
    ).toBe(false)
    expect(
      belongsInNeedsYouGroup(
        session({ status: "waiting_input", archived: true }),
        idle,
      ),
    ).toBe(false)
  })

  it("ignores running and idle sessions", () => {
    expect(belongsInNeedsYouGroup(session({ status: "running" }), idle)).toBe(
      false,
    )
    expect(belongsInNeedsYouGroup(session(), idle)).toBe(false)
  })

  it("stays empty while searching, so hits are not listed twice", () => {
    expect(
      belongsInNeedsYouGroup(session({ status: "waiting_input" }), {
        ...idle,
        searching: true,
      }),
    ).toBe(false)
  })
})

describe("settled group", () => {
  it("holds settled sessions", () => {
    expect(belongsInSettledGroup(session({ settledAt: 5 }), idle)).toBe(true)
  })

  it("does not repeat the open session the groups above already show", () => {
    const open = session({ id: "s9", settledAt: 5 })
    expect(
      belongsInSettledGroup(open, { ...idle, activeId: "s9" }),
    ).toBe(false)
  })

  it("stays empty while searching, so hits are not listed twice", () => {
    expect(
      belongsInSettledGroup(session({ settledAt: 5 }), {
        ...idle,
        searching: true,
      }),
    ).toBe(false)
  })

  it("never holds an unsettled or archived session", () => {
    expect(belongsInSettledGroup(session(), idle)).toBe(false)
    expect(
      belongsInSettledGroup(session({ settledAt: 5, archived: true }), idle),
    ).toBe(false)
  })

  it("lets Favorites keep a settled favourite, rather than repeating it", () => {
    expect(
      belongsInSettledGroup(session({ settledAt: 5, favorite: true }), idle),
    ).toBe(false)
  })
})

describe("favorites group", () => {
  it("holds a favourite from any project", () => {
    expect(belongsInFavoritesGroup(session({ favorite: true }), idle)).toBe(true)
  })

  it("still holds it once the thread settles", () => {
    expect(
      belongsInFavoritesGroup(session({ favorite: true, settledAt: 5 }), idle),
    ).toBe(true)
  })

  it("hands a waiting favourite to Needs you until it is handled", () => {
    expect(
      belongsInFavoritesGroup(
        session({ favorite: true, status: "waiting_input" }),
        idle,
      ),
    ).toBe(false)
  })

  it("takes a done favourite back once it has been seen", () => {
    const done = session({ favorite: true, status: "done", updatedAt: 7 })
    expect(belongsInFavoritesGroup(done, idle)).toBe(false)
    expect(belongsInFavoritesGroup(done, { ...idle, seen: { s1: 7 } })).toBe(
      true,
    )
  })

  it("ignores a session nobody favourited", () => {
    expect(belongsInFavoritesGroup(session(), idle)).toBe(false)
  })

  it("never holds an archived favourite", () => {
    expect(
      belongsInFavoritesGroup(session({ favorite: true, archived: true }), idle),
    ).toBe(false)
  })

  it("stays empty while searching, so hits are not listed twice", () => {
    expect(
      belongsInFavoritesGroup(session({ favorite: true }), {
        ...idle,
        searching: true,
      }),
    ).toBe(false)
  })
})

describe("the four groups partition the sidebar", () => {
  const all = [
    session({ id: "live" }),
    session({ id: "settled", settledAt: 5 }),
    session({ id: "open", settledAt: 5 }),
    session({ id: "fav", favorite: true }),
    session({ id: "fav-settled", favorite: true, settledAt: 5 }),
    session({ id: "waiting", status: "waiting_input" }),
    session({ id: "failed", status: "error" }),
    session({ id: "fresh-done", status: "done" }),
    session({ id: "seen-done", status: "done", updatedAt: 2 }),
    session({ id: "fav-waiting", favorite: true, status: "waiting_input" }),
  ]

  const groupsHolding = (s: SessionMeta, ctx: RowContext) =>
    [
      belongsInNeedsYouGroup(s, ctx),
      belongsInFavoritesGroup(s, ctx),
      belongsInProjectGroups(s, ctx),
      belongsInSettledGroup(s, ctx),
    ].filter(Boolean)

  it("puts every unarchived session in exactly one of them", () => {
    const ctx: RowContext = {
      searching: false,
      statusFiltered: false,
      activeId: "open",
      seen: { "seen-done": 2 },
    }
    for (const s of all) {
      expect(groupsHolding(s, ctx)).toHaveLength(1)
    }
  })

  it("still puts each in exactly one once a query is typed", () => {
    const ctx: RowContext = {
      searching: true,
      statusFiltered: false,
      activeId: "open",
      seen: { "seen-done": 2 },
    }
    for (const s of all) {
      expect(groupsHolding(s, ctx)).toHaveLength(1)
    }
  })

  it("still puts each in exactly one while a status chip filters", () => {
    const ctx: RowContext = {
      searching: false,
      statusFiltered: true,
      activeId: "open",
      seen: { "seen-done": 2 },
    }
    for (const s of all) {
      expect(groupsHolding(s, ctx)).toHaveLength(1)
    }
  })

  it("leaves an archived session out of all four", () => {
    const ctx: RowContext = {
      searching: false,
      statusFiltered: false,
      activeId: "open",
      seen: { "seen-done": 2 },
    }
    for (const s of all) {
      expect(groupsHolding({ ...s, archived: true }, ctx)).toHaveLength(0)
    }
  })
})

describe("status chip bypass", () => {
  const filtered: RowContext = { ...idle, statusFiltered: true }

  it("returns attention sessions to the project groups while a chip is active", () => {
    const waiting = session({ status: "waiting_input" })
    expect(belongsInNeedsYouGroup(waiting, filtered)).toBe(false)
    expect(belongsInProjectGroups(waiting, filtered)).toBe(true)
  })

  it("keeps the pre-branch favourite lift while a chip is active", () => {
    const favWaiting = session({ favorite: true, status: "waiting_input" })
    expect(belongsInFavoritesGroup(favWaiting, filtered)).toBe(true)
    expect(belongsInProjectGroups(favWaiting, filtered)).toBe(false)
  })

  it("still excludes settled sessions from the project groups", () => {
    expect(
      belongsInProjectGroups(session({ settledAt: 5 }), filtered),
    ).toBe(false)
  })
})

describe("sessionBucket", () => {
  const sample = [
    session({ id: "live" }),
    session({ id: "settled", settledAt: 5 }),
    session({ id: "open", settledAt: 5 }),
    session({ id: "fav", favorite: true }),
    session({ id: "waiting", status: "waiting_input" }),
    session({ id: "failed", status: "error" }),
    session({ id: "fresh-done", status: "done" }),
    session({ id: "seen-done", status: "done", updatedAt: 2 }),
    session({ id: "fav-waiting", favorite: true, status: "waiting_input" }),
    session({ id: "gone", archived: true }),
  ]

  const contexts: RowContext[] = [
    { searching: false, statusFiltered: false, activeId: "open", seen: { "seen-done": 2 } },
    { searching: true, statusFiltered: false, activeId: "open", seen: { "seen-done": 2 } },
    { searching: false, statusFiltered: true, activeId: "open", seen: { "seen-done": 2 } },
    { searching: false, statusFiltered: false, activeId: null, seen: {} },
  ]

  it("agrees with the four membership predicates in every context", () => {
    for (const ctx of contexts) {
      for (const s of sample) {
        const bucket = sessionBucket(s, ctx)
        expect(bucket === "archived").toBe(s.archived === true)
        expect(bucket === "needs-you").toBe(belongsInNeedsYouGroup(s, ctx))
        expect(bucket === "favorites").toBe(belongsInFavoritesGroup(s, ctx))
        expect(bucket === "settled").toBe(belongsInSettledGroup(s, ctx))
        expect(bucket === "projects").toBe(belongsInProjectGroups(s, ctx))
      }
    }
  })
})

describe("partitionSidebarRows", () => {
  const waiting = session({ id: "w", status: "waiting_input", updatedAt: 10 })
  const failed = session({ id: "f", status: "error", updatedAt: 20 })
  const done = session({ id: "d", status: "done", updatedAt: 30 })
  const plain = session({ id: "p", updatedAt: 40 })
  const fav = session({ id: "s", favorite: true, updatedAt: 50 })
  const put = session({ id: "z", settledAt: 5, updatedAt: 60 })
  const sessions = [waiting, failed, done, plain, fav, put]
  const queue = [waiting, failed, done]

  it("passes the queue through in its given order, without re-filtering", () => {
    const rows = partitionSidebarRows(sessions, queue, idle, null)
    expect(rows.needsYou.map((s) => s.id)).toEqual(["w", "f", "d"])
    expect(rows.favorites.map((s) => s.id)).toEqual(["s"])
    expect(rows.projects.map((s) => s.id)).toEqual(["p"])
    expect(rows.settled.map((s) => s.id)).toEqual(["z"])
    expect(rows.archived).toEqual([])
  })

  it("hides the queue and restores classic groups while a chip filters", () => {
    const rows = partitionSidebarRows(
      sessions,
      queue,
      { ...idle, statusFiltered: true },
      null,
    )
    expect(rows.needsYou).toEqual([])
    expect(rows.projects.map((s) => s.id).sort()).toEqual(["d", "f", "p", "w"])
  })

  it("holds a row in Needs you at its old index while it is being renamed", () => {
    const hold: RowHold = { session: failed, seen: {}, queueIndex: 1 }
    const seenNow = { f: failed.updatedAt }
    const settledQueue = [waiting, done]
    const rows = partitionSidebarRows(
      sessions,
      settledQueue,
      { ...idle, seen: seenNow },
      hold,
    )
    expect(rows.needsYou.map((s) => s.id)).toEqual(["w", "f", "d"])
    expect(rows.projects.map((s) => s.id)).toEqual(["p"])
  })

  it("re-inserts the live row, so its rendered fields stay current", () => {
    const renamed = { ...failed, title: "Renamed meanwhile" }
    const hold: RowHold = { session: failed, seen: {}, queueIndex: 0 }
    const rows = partitionSidebarRows(
      [renamed, plain],
      [],
      { ...idle, seen: { f: failed.updatedAt } },
      hold,
    )
    expect(rows.needsYou[0]?.title).toBe("Renamed meanwhile")
  })

  it("holds a row in its project group when it starts waiting mid-interaction", () => {
    const wasIdle = session({ id: "p2", updatedAt: 40 })
    const nowWaiting = { ...wasIdle, status: "waiting_input" as const }
    const hold: RowHold = { session: wasIdle, seen: {}, queueIndex: -1 }
    const rows = partitionSidebarRows(
      [nowWaiting, plain],
      [nowWaiting],
      idle,
      hold,
    )
    expect(rows.needsYou).toEqual([])
    expect(rows.projects.map((s) => s.id).sort()).toEqual(["p", "p2"])
  })

  it("lets the deferred reparent land once the hold is released", () => {
    const wasIdle = session({ id: "p2", updatedAt: 40 })
    const nowWaiting = { ...wasIdle, status: "waiting_input" as const }
    const rows = partitionSidebarRows(
      [nowWaiting, plain],
      [nowWaiting],
      idle,
      null,
    )
    expect(rows.needsYou.map((s) => s.id)).toEqual(["p2"])
    expect(rows.projects.map((s) => s.id)).toEqual(["p"])
  })
})
