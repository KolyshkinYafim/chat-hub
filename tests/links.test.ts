import { describe, expect, it } from "vitest"
import {
  isBareUrlParagraph,
  isSafeHttpUrl,
  linkDisplay,
  middleTruncate,
  trimTrailingPunctuation,
  URL_PATTERN,
} from "../src/renderer/src/lib/links"

describe("URL_PATTERN", () => {
  it("finds a bare url inside prose without its trailing period", () => {
    const text = "Готово, запощено: https://topbuild.dev/nsfw/back/-/merge_requests/61#note_21576. Дальше сам."
    const m = text.match(URL_PATTERN)
    expect(m).toEqual([
      "https://topbuild.dev/nsfw/back/-/merge_requests/61#note_21576",
    ])
  })

  it("stops at closing parenthesis and quotes", () => {
    expect("(see https://example.com/a)".match(URL_PATTERN)).toEqual([
      "https://example.com/a",
    ])
    expect('"https://example.com/b"'.match(URL_PATTERN)).toEqual([
      "https://example.com/b",
    ])
  })

  it("matches nothing in plain prose", () => {
    expect("no links here, just words.".match(URL_PATTERN)).toBeNull()
  })
})

describe("isBareUrlParagraph", () => {
  it("accepts a paragraph that is exactly one url", () => {
    expect(isBareUrlParagraph("  https://gitlab.com/g/p/-/merge_requests/61 ")).toBe(
      "https://gitlab.com/g/p/-/merge_requests/61",
    )
  })

  it("rejects a paragraph with surrounding words", () => {
    expect(isBareUrlParagraph("link: https://gitlab.com/x")).toBeNull()
  })

  it("rejects non-http schemes", () => {
    expect(isBareUrlParagraph("javascript:alert(1)")).toBeNull()
    expect(isBareUrlParagraph("file:///etc/passwd")).toBeNull()
  })
})

describe("linkDisplay", () => {
  it("names a gitlab merge request", () => {
    const d = linkDisplay(
      "https://topbuild.dev/nsfw/back/image-service/-/merge_requests/61#note_21576",
    )
    expect(d.host).toBe("topbuild.dev")
    expect(d.hint).toBe("MR !61")
  })

  it("names a github pull request and an issue", () => {
    expect(linkDisplay("https://github.com/o/r/pull/123").hint).toBe("PR #123")
    expect(linkDisplay("https://github.com/o/r/issues/45").hint).toBe(
      "Issue #45",
    )
  })

  it("drops www and uses the host as label for a root url", () => {
    const d = linkDisplay("https://www.example.com/")
    expect(d.host).toBe("example.com")
    expect(d.label).toBe("example.com")
    expect(d.hint).toBeNull()
  })

  it("middle-truncates a long path", () => {
    const d = linkDisplay(
      "https://example.com/very/long/path/that/keeps/going/and/going/until/it/must/stop",
    )
    expect(d.label.length).toBeLessThanOrEqual(44)
    expect(d.label).toContain("…")
  })
})

describe("helpers", () => {
  it("trims trailing punctuation but keeps inner punctuation", () => {
    expect(trimTrailingPunctuation("https://a.b/c#d.")).toBe("https://a.b/c#d")
    expect(trimTrailingPunctuation("https://a.b/c?x=1,y=2")).toBe(
      "https://a.b/c?x=1,y=2",
    )
  })

  it("only blesses http and https", () => {
    expect(isSafeHttpUrl("https://x.y")).toBe(true)
    expect(isSafeHttpUrl("http://x.y")).toBe(true)
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isSafeHttpUrl("not a url")).toBe(false)
  })

  it("middleTruncate keeps short strings intact", () => {
    expect(middleTruncate("short", 44)).toBe("short")
  })
})
