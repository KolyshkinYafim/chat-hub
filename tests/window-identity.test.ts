import { describe, expect, it } from "vitest"

import {
  defaultWindowIntent,
  parseWindowIntent,
  windowQuery,
  windowScopedKey,
} from "../src/shared/window-identity"

describe("windowScopedKey", () => {
  it("leaves window 1 on the key it has always written", () => {
    // The whole no-migration promise rests on this line.
    expect(windowScopedKey("chat-hub.workspace.panes", 1)).toBe(
      "chat-hub.workspace.panes",
    )
  })

  it("suffixes every other window", () => {
    expect(windowScopedKey("chat-hub.workspace.panes", 2)).toBe(
      "chat-hub.workspace.panes.w2",
    )
    expect(windowScopedKey("chat-hub.surfaceDock.open", 17)).toBe(
      "chat-hub.surfaceDock.open.w17",
    )
  })

  it("gives different windows different keys", () => {
    const keys = [1, 2, 3].map((id) => windowScopedKey("k", id))
    expect(new Set(keys).size).toBe(3)
  })
})

describe("windowQuery", () => {
  it("carries the id alone for a window being restored", () => {
    expect(windowQuery({ windowId: 3, fresh: false, sessionId: null })).toBe(
      "?windowId=3",
    )
  })

  it("marks a window the user asked for", () => {
    expect(windowQuery({ windowId: 2, fresh: true, sessionId: null })).toBe(
      "?windowId=2&fresh=1",
    )
  })

  it("names the chat an open-in-new-window should land on", () => {
    expect(windowQuery({ windowId: 2, fresh: true, sessionId: "s1" })).toBe(
      "?windowId=2&fresh=1&session=s1",
    )
  })

  it("escapes a session id rather than splitting the query", () => {
    const query = windowQuery({
      windowId: 2,
      fresh: false,
      sessionId: "a&b=c d",
    })
    expect(parseWindowIntent(query).sessionId).toBe("a&b=c d")
  })
})

describe("parseWindowIntent", () => {
  it("round-trips what windowQuery wrote", () => {
    const intent = { windowId: 4, fresh: true, sessionId: "s9" }
    expect(parseWindowIntent(windowQuery(intent))).toEqual(intent)
  })

  it("reads a query string with or without its leading question mark", () => {
    expect(parseWindowIntent("?windowId=2").windowId).toBe(2)
    expect(parseWindowIntent("windowId=2").windowId).toBe(2)
  })

  it("falls back to window 1 when there is no query at all", () => {
    expect(parseWindowIntent("")).toEqual(defaultWindowIntent())
  })

  it("falls back to window 1 on a junk or hostile id", () => {
    // A window that guessed wrong here would read another window's panes.
    for (const raw of ["abc", "0", "-3", "1.5", "", "NaN"]) {
      expect(parseWindowIntent(`?windowId=${raw}`).windowId).toBe(1)
    }
  })

  it("treats a missing or empty session as no session", () => {
    expect(parseWindowIntent("?windowId=2").sessionId).toBeNull()
    expect(parseWindowIntent("?windowId=2&session=").sessionId).toBeNull()
  })

  it("only reads fresh from an exact 1", () => {
    expect(parseWindowIntent("?windowId=2&fresh=1").fresh).toBe(true)
    expect(parseWindowIntent("?windowId=2&fresh=0").fresh).toBe(false)
    expect(parseWindowIntent("?windowId=2&fresh=true").fresh).toBe(false)
  })

  it("ignores unrelated params the dev mock adds", () => {
    const intent = parseWindowIntent("?windowId=2&mock=1&fresh=1")
    expect(intent).toEqual({ windowId: 2, fresh: true, sessionId: null })
  })
})
