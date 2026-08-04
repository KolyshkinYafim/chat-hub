import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import type { ChatMessage } from "@shared/types"
import { MessageArchive } from "../src/main/message-archive"

const SESSION = "s-archive"

async function archiveWith(contents: string[]): Promise<MessageArchive> {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-archive-"))
  const archive = MessageArchive.fromStatePath(join(dir, "state.json"))
  await archive.append(
    SESSION,
    contents.map((content, i) => ({
      id: `a${i}`,
      sessionId: SESSION,
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      createdAt: 1_000 + i,
    })),
  )
  return archive
}

describe("archive search", () => {
  let archive: MessageArchive

  beforeEach(async () => {
    archive = await archiveWith([
      "the webhook retries give up too early",
      "switched the webhook to exponential backoff",
      "unrelated note about the reward curve",
    ])
  })

  it("finds a match no loaded transcript could see", async () => {
    const found = await archive.search(SESSION, "webhook", null)
    expect(found.hit?.messageId).toBe("a1")
    expect(found.hit?.hits).toBe(2)
    expect(found.truncated).toBe(false)
  })

  it("points the snippet offsets at the matched run", async () => {
    const { hit } = await archive.search(SESSION, "backoff", null)
    const { snippet, matchStart, matchLength } = hit!
    expect(snippet.slice(matchStart, matchStart + matchLength)).toBe("backoff")
  })

  it("skips what the caller already holds, so nothing is counted twice", async () => {
    const found = await archive.search(SESSION, "webhook", "a1")
    expect(found.hit?.messageId).toBe("a0")
    expect(found.hit?.hits).toBe(1)
  })

  it("reports nothing when the whole archive is already loaded", async () => {
    const found = await archive.search(SESSION, "webhook", "a0")
    expect(found.hit).toBeNull()
  })

  it("ignores a query below the minimum length", async () => {
    expect((await archive.search(SESSION, "w", null)).hit).toBeNull()
  })

  it("returns nothing for a session with no archive", async () => {
    const found = await archive.search("s-nothing", "webhook", null)
    expect(found).toEqual({ hit: null, truncated: false })
  })

  it("matches a phrase that the archive stored across a line break", async () => {
    const wrapped = await archiveWith(["retry the\nwebhook now"])
    const found = await wrapped.search(SESSION, "the webhook", null)
    expect(found.hit?.messageId).toBe("a0")
  })

  it("says so when the scan stopped before the oldest message", async () => {
    const deep = await archiveWith(
      Array.from({ length: 12 }, (_, i) =>
        i === 0 ? "the earliest webhook note" : `turn ${i}`,
      ),
    )
    const found = await deep.search(SESSION, "webhook", null, 5)
    expect(found.hit).toBeNull()
    expect(found.truncated).toBe(true)
  })
})

describe("archive jump", () => {
  async function deepArchive(): Promise<MessageArchive> {
    return archiveWith(Array.from({ length: 900 }, (_, i) => `turn ${i}`))
  }

  it("loads a page that reaches the target and touches the live window", async () => {
    const archive = await deepArchive()
    const page = await archive.loadThrough(SESSION, null, "a880")
    expect(page.reachedTarget).toBe(true)
    expect(page.messages.some((m: ChatMessage) => m.id === "a880")).toBe(true)
    // Contiguous with what the caller holds: the page ends at the archive tail.
    expect(page.messages.at(-1)?.id).toBe("a899")
    expect(page.hasMore).toBe(true)
  })

  it("keeps context above the hit", async () => {
    const archive = await deepArchive()
    const page = await archive.loadThrough(SESSION, null, "a880")
    expect(page.messages[0]?.id).toBe("a870")
  })

  it("admits when the target is further back than one jump", async () => {
    const archive = await deepArchive()
    const page = await archive.loadThrough(SESSION, null, "a10")
    expect(page.reachedTarget).toBe(false)
    expect(page.messages.some((m: ChatMessage) => m.id === "a10")).toBe(false)
    // Still contiguous, so the caller can keep scrolling from where it lands.
    expect(page.messages.at(-1)?.id).toBe("a899")
  })

  it("fetches nothing when the target is already loaded", async () => {
    const archive = await deepArchive()
    const page = await archive.loadThrough(SESSION, "a800", "a880")
    expect(page.reachedTarget).toBe(true)
    expect(page.messages).toEqual([])
  })

  it("reports an unknown message id rather than guessing a page", async () => {
    const archive = await deepArchive()
    const page = await archive.loadThrough(SESSION, null, "nope")
    expect(page.reachedTarget).toBe(false)
    expect(page.messages).toEqual([])
  })
})
