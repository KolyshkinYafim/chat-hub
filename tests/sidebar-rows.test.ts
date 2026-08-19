import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import {
  belongsInProjectGroups,
  belongsInSettledGroup,
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
})

describe("the two groups partition the sidebar", () => {
  it("puts every unarchived session in exactly one of them", () => {
    const ctx = { searching: false, activeId: "open" }
    const all = [
      session({ id: "live" }),
      session({ id: "settled", settledAt: 5 }),
      session({ id: "open", settledAt: 5 }),
    ]
    for (const s of all) {
      const inGroups = belongsInProjectGroups(s, ctx)
      const inSettled = belongsInSettledGroup(s, ctx)
      expect(inGroups !== inSettled).toBe(true)
    }
  })
})
