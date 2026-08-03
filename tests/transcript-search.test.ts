import { describe, expect, it } from "vitest"
import type { ChatMessage } from "@shared/types"
import {
  excerpt,
  MIN_TRANSCRIPT_QUERY,
  searchTranscripts,
} from "@renderer/lib/search"

function msg(id: string, sessionId: string, content: string): ChatMessage {
  return { id, sessionId, role: "assistant", content, createdAt: 0 }
}

describe("excerpt", () => {
  it("collapses whitespace so the offsets index the rendered string", () => {
    const hit = excerpt("first line\n\n   second  line", "second")
    expect(hit).not.toBeNull()
    const { snippet, matchStart, matchLength } = hit!
    expect(snippet.slice(matchStart, matchStart + matchLength)).toBe("second")
  })

  it("elides both sides of a long body and still points at the match", () => {
    const body = `${"a ".repeat(200)}needle${" b".repeat(200)}`
    const hit = excerpt(body, "needle")!
    expect(hit.snippet.startsWith("…")).toBe(true)
    expect(hit.snippet.endsWith("…")).toBe(true)
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + 6)).toBe("needle")
  })

  it("matches case-insensitively but reports the text as written", () => {
    const hit = excerpt("Retry the Webhook now", "webhook")!
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + 7)).toBe("Webhook")
  })

  it("returns null when the text does not contain the query", () => {
    expect(excerpt("nothing here", "webhook")).toBeNull()
  })
})

describe("searchTranscripts", () => {
  const messages: Record<string, ChatMessage[]> = {
    s1: [
      msg("m1", "s1", "Extract the JWT verification into middleware"),
      msg("m2", "s1", "Added tests for the JWT edge cases"),
    ],
    s2: [msg("m3", "s2", "Webhook retries now back off")],
  }

  it("ignores a query shorter than the minimum", () => {
    expect(searchTranscripts("j", messages).size).toBe(0)
    expect("jw".length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_QUERY)
  })

  it("reports the latest matching message of each session", () => {
    const hits = searchTranscripts("jwt", messages)
    expect(hits.get("s1")?.messageId).toBe("m2")
    expect(hits.get("s1")?.hits).toBe(2)
    expect(hits.has("s2")).toBe(false)
  })

  it("counts matching messages, not occurrences within one message", () => {
    const hits = searchTranscripts("retries", messages)
    expect(hits.get("s2")?.hits).toBe(1)
  })

  it("returns nothing when no transcript matches", () => {
    expect(searchTranscripts("kubernetes", messages).size).toBe(0)
  })
})
