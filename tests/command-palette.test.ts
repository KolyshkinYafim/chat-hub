import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import { fuzzyScore } from "../src/renderer/src/lib/fuzzy"
import {
  AGENT_INBOX_KEY,
  AGENT_INBOX_MATCH,
  buildPaletteEntries,
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

function kinds(entries: ReturnType<typeof buildPaletteEntries>) {
  return entries.map((e) => (e.kind === "command" ? e.key : e.session.id))
}

describe("buildPaletteEntries", () => {
  it("puts commands after the sessions on an empty query", () => {
    const a = session({ title: "Fix webhook retries" })
    const b = session({ title: "Tune reward curve" })
    const entries = buildPaletteEntries([a, b], "", 2, 2)
    expect(kinds(entries)).toEqual([
      b.id,
      a.id,
      AGENT_INBOX_KEY,
      NEXT_ATTENTION_KEY,
    ])
  })

  it("keeps Enter opening the most recent session on an empty query", () => {
    const older = session({ updatedAt: 10 })
    const newer = session({ updatedAt: 20 })
    const entries = buildPaletteEntries([older, newer], "", 1)
    expect(entries[0]).toEqual({ kind: "session", session: newer })
  })

  it("hides next waiting when nothing needs attention but keeps the inbox", () => {
    const entries = buildPaletteEntries([session()], "", 0)
    expect(kinds(entries)).not.toContain(NEXT_ATTENTION_KEY)
    expect(kinds(entries)).toContain(AGENT_INBOX_KEY)
  })

  it("hides commands when the query does not match them", () => {
    expect(fuzzyScore("fix webhook", NEXT_ATTENTION_MATCH)).toBeNull()
    expect(fuzzyScore("fix webhook", AGENT_INBOX_MATCH)).toBeNull()
    const a = session({ title: "Fix webhook retries" })
    const entries = buildPaletteEntries([a], "fix webhook", 3, 3)
    expect(kinds(entries)).toEqual([a.id])
  })

  it("ranks next waiting only above sessions it strictly outscores", () => {
    const weak = session({ title: "next wailing rating" })
    const weakScore = fuzzyScore(
      "next waiting",
      `${weak.title} ${weak.project} ${weak.provider}`,
    )
    const commandScore = fuzzyScore("next waiting", NEXT_ATTENTION_MATCH)
    expect(weakScore).not.toBeNull()
    expect(commandScore ?? 0).toBeGreaterThan(weakScore ?? 0)
    const entries = buildPaletteEntries([weak], "next waiting", 1)
    expect(kinds(entries)[0]).toBe(NEXT_ATTENTION_KEY)
    expect(kinds(entries)).toContain(weak.id)
  })

  it("keeps an equally scoring session above next waiting", () => {
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

  it("surfaces the inbox command for an inbox query", () => {
    const a = session({ title: "Fix webhook retries" })
    const entries = buildPaletteEntries([a], "inbox", 1, 4)
    expect(kinds(entries)[0]).toBe(AGENT_INBOX_KEY)
    const inbox = entries.find(
      (entry) => entry.kind === "command" && entry.key === AGENT_INBOX_KEY,
    )
    expect(inbox?.kind === "command" && inbox.sub).toContain("4 waiting")
  })

  it("caps session results while still listing commands", () => {
    const many = Array.from({ length: 20 }, () => session())
    const entries = buildPaletteEntries(many, "", 1, 1)
    expect(entries.filter((e) => e.kind === "session")).toHaveLength(12)
    expect(kinds(entries)).toContain(AGENT_INBOX_KEY)
    expect(kinds(entries)).toContain(NEXT_ATTENTION_KEY)
  })

  it("gives every entry a stable, unique key", () => {
    const a = session()
    const entries = buildPaletteEntries([a], "", 1)
    const keys = entries.map(paletteKey)
    expect(keys).toEqual([a.id, AGENT_INBOX_KEY, NEXT_ATTENTION_KEY])
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
