import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import {
  belongsInFavoritesGroup,
  belongsInNeedsYouGroup,
  belongsInProjectGroups,
  belongsInSettledGroup,
  type RowContext,
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

const idle: RowContext = { searching: false, activeId: null, seen: {} }

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
      activeId: "open",
      seen: { "seen-done": 2 },
    }
    for (const s of all) {
      expect(groupsHolding({ ...s, archived: true }, ctx)).toHaveLength(0)
    }
  })
})
