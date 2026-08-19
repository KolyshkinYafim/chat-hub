// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import {
  loadStash,
  pushStash,
  removeStash,
  STASH_LIMIT,
} from "@renderer/lib/prompt-stash"

const KEY = "chat-hub.promptStash"

describe("prompt stash", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips push, load and remove", () => {
    const afterPush = pushStash("remember this", "s1")
    expect(afterPush).toHaveLength(1)
    expect(afterPush[0].text).toBe("remember this")
    expect(afterPush[0].sessionId).toBe("s1")
    expect(afterPush[0].at).toBeGreaterThan(0)

    const loaded = loadStash()
    expect(loaded).toEqual(afterPush)

    const afterRemove = removeStash(afterPush[0].id)
    expect(afterRemove).toEqual([])
    expect(loadStash()).toEqual([])
  })

  it("keeps newest first and caps at 20, dropping the oldest", () => {
    for (let i = 0; i < STASH_LIMIT + 1; i++) {
      pushStash(`draft ${i}`, "s1")
    }
    const entries = loadStash()
    expect(entries).toHaveLength(STASH_LIMIT)
    expect(entries[0].text).toBe(`draft ${STASH_LIMIT}`)
    expect(entries[entries.length - 1].text).toBe("draft 1")
    expect(entries.some((e) => e.text === "draft 0")).toBe(false)
  })

  it("treats garbage localStorage as an empty stash", () => {
    localStorage.setItem(KEY, "{not json")
    expect(loadStash()).toEqual([])

    localStorage.setItem(KEY, JSON.stringify({ nope: true }))
    expect(loadStash()).toEqual([])

    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "x" }, { id: "ok", text: "t", sessionId: "s", at: 1 }, 7]),
    )
    const entries = loadStash()
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe("ok")
  })

  it("trims text and rejects empty or whitespace-only drafts", () => {
    expect(pushStash("", "s1")).toEqual([])
    expect(pushStash("   \n\t ", "s1")).toEqual([])
    expect(localStorage.getItem(KEY)).toBeNull()

    const entries = pushStash("  padded draft \n", "s1")
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe("padded draft")
  })

  it("assigns unique ids", () => {
    for (let i = 0; i < 10; i++) {
      pushStash(`draft ${i}`, "s1")
    }
    const ids = loadStash().map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
