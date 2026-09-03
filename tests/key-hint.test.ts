import { describe, expect, it } from "vitest"
import { hostPlatform, keyHint } from "../src/renderer/src/lib/key-hint"

describe("keyHint", () => {
  it("returns mac glyphs untouched on darwin", () => {
    expect(keyHint("⌘K", "darwin")).toBe("⌘K")
    expect(keyHint("⌥⇧U", "darwin")).toBe("⌥⇧U")
  })

  it("maps single-modifier chords to Ctrl on linux", () => {
    expect(keyHint("⌘K", "linux")).toBe("Ctrl+K")
    expect(keyHint("⌘N", "linux")).toBe("Ctrl+N")
    expect(keyHint("⌘,", "linux")).toBe("Ctrl+,")
    expect(keyHint("⌘/", "linux")).toBe("Ctrl+/")
  })

  it("maps stacked modifiers in order", () => {
    expect(keyHint("⌥⇧U", "linux")).toBe("Alt+Shift+U")
    expect(keyHint("⇧⌘F", "linux")).toBe("Shift+Ctrl+F")
    expect(keyHint("⌘⇧N", "linux")).toBe("Ctrl+Shift+N")
    expect(keyHint("⌘⌥1–9", "linux")).toBe("Ctrl+Alt+1–9")
  })

  it("maps mac key glyphs to their names", () => {
    expect(keyHint("⌃⇥", "linux")).toBe("Ctrl+Tab")
    expect(keyHint("⇧⇥", "linux")).toBe("Shift+Tab")
    expect(keyHint("⌘↩", "linux")).toBe("Ctrl+Enter")
    expect(keyHint("⇥", "linux")).toBe("Tab")
  })

  it("keeps arrows and slashes inside a chord", () => {
    expect(keyHint("⌥⌘←/→", "linux")).toBe("Alt+Ctrl+←/→")
  })

  it("drops the joiner before a space so prose stays readable", () => {
    expect(keyHint("⇧ moves the pane", "linux")).toBe("Shift moves the pane")
    expect(keyHint("hold ⌃ and tap ⇥ to cycle", "linux")).toBe(
      "hold Ctrl and tap Tab to cycle",
    )
    expect(keyHint("Send · ⇧Enter for a newline", "linux")).toBe(
      "Send · Shift+Enter for a newline",
    )
  })

  it("translates every glyph in mixed prose", () => {
    expect(keyHint("Zoom in · ⌘− out · ⌘0 back to 100%", "linux")).toBe(
      "Zoom in · Ctrl+− out · Ctrl+0 back to 100%",
    )
  })

  it("behaves the same on win32", () => {
    expect(keyHint("⌘S", "win32")).toBe("Ctrl+S")
    expect(keyHint("⌥⇧I", "win32")).toBe("Alt+Shift+I")
  })

  it("leaves plain labels alone", () => {
    expect(keyHint("Esc", "linux")).toBe("Esc")
    expect(keyHint("Enter", "linux")).toBe("Enter")
    expect(keyHint("← →", "linux")).toBe("← →")
  })
})

describe("hostPlatform", () => {
  it("falls back to darwin without a bridge", () => {
    expect(hostPlatform()).toBe("darwin")
  })
})
