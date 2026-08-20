import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import {
  belongsInFavoritesGroup,
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

const idle = { searching: false, activeId: null }

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

  it("drops the open session when it is a favourite, not to lose it twice", () => {
    const open = session({ id: "s9", favorite: true, settledAt: 5 })
    expect(
      belongsInProjectGroups(open, { searching: false, activeId: "s9" }),
    ).toBe(false)
  })

  it("keeps the open session listed even once it settles", () => {
    const open = session({ id: "s9", settledAt: 5 })
    expect(
      belongsInProjectGroups(open, { searching: false, activeId: "s9" }),
    ).toBe(true)
  })

  it("never lists an archived session, open or not", () => {
    const gone = session({ id: "s9", archived: true, settledAt: 5 })
    expect(belongsInProjectGroups(gone, { searching: true, activeId: "s9" })).toBe(
      false,
    )
  })

  it("lists everything unarchived while a query is typed", () => {
    expect(
      belongsInProjectGroups(session({ settledAt: 5 }), {
        searching: true,
        activeId: null,
      }),
    ).toBe(true)
  })
})

describe("settled group", () => {
  it("holds settled sessions", () => {
    expect(belongsInSettledGroup(session({ settledAt: 5 }), idle)).toBe(true)
  })

  it("does not repeat the open session the groups above already show", () => {
    const open = session({ id: "s9", settledAt: 5 })
    expect(
      belongsInSettledGroup(open, { searching: false, activeId: "s9" }),
    ).toBe(false)
  })

  it("stays empty while searching, so hits are not listed twice", () => {
    expect(
      belongsInSettledGroup(session({ settledAt: 5 }), {
        searching: true,
        activeId: null,
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
        searching: true,
        activeId: null,
      }),
    ).toBe(false)
  })
})

describe("the three groups partition the sidebar", () => {
  const all = [
    session({ id: "live" }),
    session({ id: "settled", settledAt: 5 }),
    session({ id: "open", settledAt: 5 }),
    session({ id: "fav", favorite: true }),
    session({ id: "fav-settled", favorite: true, settledAt: 5 }),
  ]

  const groupsHolding = (s: SessionMeta, ctx: RowContext) =>
    [
      belongsInFavoritesGroup(s, ctx),
      belongsInProjectGroups(s, ctx),
      belongsInSettledGroup(s, ctx),
    ].filter(Boolean)

  it("puts every unarchived session in exactly one of them", () => {
    const ctx = { searching: false, activeId: "open" }
    for (const s of all) {
      expect(groupsHolding(s, ctx)).toHaveLength(1)
    }
  })

  it("still puts each in exactly one once a query is typed", () => {
    const ctx = { searching: true, activeId: "open" }
    for (const s of all) {
      expect(groupsHolding(s, ctx)).toHaveLength(1)
    }
  })

  it("leaves an archived session out of all three", () => {
    const ctx = { searching: false, activeId: "open" }
    for (const s of all) {
      expect(groupsHolding({ ...s, archived: true }, ctx)).toHaveLength(0)
    }
  })
})
