import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import { fuzzyScore } from "../src/renderer/src/lib/fuzzy"
import {
  buildPaletteEntries,
  NEW_WINDOW_KEY,
  NEXT_ATTENTION_KEY,
  NEXT_ATTENTION_MATCH,
  paletteKey,
  resolvePaletteCursor,
} from "../src/renderer/src/lib/palette"

let seq = 0

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  seq += 1
  return {
    id: `s${seq}`,
    title: `Session ${seq}`,
    project: "hub",
    provider: "claude",
    cwd: "/tmp/hub",
    status: "idle",
    createdAt: 1,
    updatedAt: seq,
    ...patch,
  }
}

/** Commands show up as their own key: two of them must stay distinguishable. */
function kinds(entries: ReturnType<typeof buildPaletteEntries>) {
  return entries.map((e) => (e.kind === "command" ? e.key : e.session.id))
}

describe("buildPaletteEntries", () => {
  it("puts the commands after the sessions on an empty query", () => {
    const a = session({ title: "Fix webhook retries" })
    const b = session({ title: "Tune reward curve" })
    const entries = buildPaletteEntries([a, b], "", 2)
    expect(kinds(entries)).toEqual([
      b.id,
      a.id,
      NEXT_ATTENTION_KEY,
      NEW_WINDOW_KEY,
    ])
  })

  it("keeps Enter opening the most recent session on an empty query", () => {
    const older = session({ updatedAt: 10 })
    const newer = session({ updatedAt: 20 })
    const entries = buildPaletteEntries([older, newer], "", 1)
    expect(entries[0]).toEqual({ kind: "session", session: newer })
  })

  it("hides the attention command when nothing needs attention", () => {
    const entries = buildPaletteEntries([session()], "", 0)
    expect(kinds(entries)).not.toContain(NEXT_ATTENTION_KEY)
  })

  it("offers a new window even with nothing waiting", () => {
    // Unlike Next waiting, it is never conditional on the queue.
    const entries = buildPaletteEntries([session()], "", 0)
    expect(kinds(entries)).toContain(NEW_WINDOW_KEY)
  })

  it("hides the commands when the query does not match them", () => {
    expect(fuzzyScore("fix webhook", NEXT_ATTENTION_MATCH)).toBeNull()
    const a = session({ title: "Fix webhook retries" })
    const entries = buildPaletteEntries([a], "fix webhook", 3)
    expect(kinds(entries)).toEqual([a.id])
  })

  it("finds the new-window command by name", () => {
    const a = session({ title: "Fix webhook retries" })
    const entries = buildPaletteEntries([a], "new window", 0)
    expect(kinds(entries)[0]).toBe(NEW_WINDOW_KEY)
  })

  it("ranks the command only above sessions it strictly outscores", () => {
    const weak = session({ title: "next wailing rating" })
    const weakScore = fuzzyScore(
      "next waiting",
      `${weak.title} ${weak.project} ${weak.provider}`,
    )
    const commandScore = fuzzyScore("next waiting", NEXT_ATTENTION_MATCH)
    expect(weakScore).not.toBeNull()
    expect(commandScore ?? 0).toBeGreaterThan(weakScore ?? 0)
    const entries = buildPaletteEntries([weak], "next waiting", 1)
    expect(kinds(entries)).toEqual([NEXT_ATTENTION_KEY, weak.id])
  })

  it("keeps an equally scoring session above the command", () => {
    const exact = session({ title: "Next waiting improvements" })
    const sessionScore = fuzzyScore(
      "next waiting",
      `${exact.title} ${exact.project} ${exact.provider}`,
    )
    const commandScore = fuzzyScore("next waiting", NEXT_ATTENTION_MATCH)
    expect(sessionScore).toBe(commandScore)
    const entries = buildPaletteEntries([exact], "next waiting", 1)
    expect(kinds(entries)).toEqual([exact.id, NEXT_ATTENTION_KEY])
  })

  it("caps session results while still listing the commands", () => {
    const many = Array.from({ length: 20 }, () => session())
    const entries = buildPaletteEntries(many, "", 1)
    expect(entries).toHaveLength(14)
    expect(kinds(entries).slice(-2)).toEqual([
      NEXT_ATTENTION_KEY,
      NEW_WINDOW_KEY,
    ])
  })

  it("gives every entry a stable, unique key", () => {
    const a = session()
    const entries = buildPaletteEntries([a], "", 1)
    const keys = entries.map(paletteKey)
    expect(keys).toEqual([a.id, NEXT_ATTENTION_KEY, NEW_WINDOW_KEY])
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("resolvePaletteCursor", () => {
  const keys = ["a", "b", "c"]

  it("starts on the first entry", () => {
    expect(resolvePaletteCursor(keys, { key: null, index: 0 })).toBe(0)
  })

  it("follows its key when rows shift around it", () => {
    expect(resolvePaletteCursor(keys, { key: "b", index: 0 })).toBe(1)
    expect(resolvePaletteCursor(["x", "b"], { key: "b", index: 1 })).toBe(1)
  })

  it("clamps to the remembered index when the key is gone", () => {
    expect(resolvePaletteCursor(keys, { key: "gone", index: 5 })).toBe(2)
    expect(resolvePaletteCursor(keys, { key: "gone", index: 1 })).toBe(1)
  })

  it("stays at zero on an empty list", () => {
    expect(resolvePaletteCursor([], { key: "a", index: 4 })).toBe(0)
  })
})
