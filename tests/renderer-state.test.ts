import { describe, expect, it } from "vitest"
import {
  parseArchived,
  pruneArchived,
  serializeArchived,
} from "@renderer/lib/archive"
import { foldToolFollowUps, parseTranscript } from "@renderer/lib/markdown"
import {
  formatSessionUsage,
  formatTokens,
  formatUsage,
  formatUsd,
} from "@renderer/lib/usage"

describe("archive set", () => {
  it("round-trips through storage", () => {
    const ids = new Set(["a", "b"])
    expect(parseArchived(serializeArchived(ids))).toEqual(ids)
  })

  it("survives a missing or corrupt value", () => {
    expect(parseArchived(null).size).toBe(0)
    expect(parseArchived("{not json").size).toBe(0)
    expect(parseArchived('{"a":1}').size).toBe(0)
    expect(parseArchived('["a", 7, null]')).toEqual(new Set(["a"]))
  })

  it("drops ids whose session no longer exists", () => {
    expect(pruneArchived(new Set(["a", "b"]), ["b", "c"])).toEqual(
      new Set(["b"]),
    )
  })
})

describe("transcript blocks", () => {
  it("folds a diff into the tool call above it", () => {
    const blocks = parseTranscript(
      "```tool:Edit\nsrc/a.ts\n```\n```diff\n-old\n+new\n```",
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: "tool", name: "Edit" })
    expect(blocks[0]).toHaveProperty("attached")
    const attached = (blocks[0] as { attached: unknown[] }).attached
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({ kind: "diff" })
  })

  it("folds a tool-result into its call but leaves prose alone", () => {
    const blocks = parseTranscript(
      "```tool:Bash\npnpm test\n```\n```tool-result:Bash\n2 passed\n```\nAll green.",
    )
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as { attached: unknown[] }).attached).toHaveLength(1)
    expect(blocks[1]).toMatchObject({ kind: "p" })
  })

  it("does not attach a diff that follows a result rather than a call", () => {
    const folded = foldToolFollowUps([
      { kind: "tool", name: "Bash", body: "", result: true },
      { kind: "diff", code: "+x" },
    ])
    expect(folded).toHaveLength(2)
  })
})

describe("usage formatting", () => {
  it("hides a total the CLI never reported", () => {
    expect(formatUsage({})).toBeNull()
    expect(formatSessionUsage({ turns: 3 })).toBeNull()
  })

  it("renders only the reported fields", () => {
    expect(formatUsage({ costUsd: 0.42 })).toBe("$0.42")
    expect(formatUsage({ inputTokens: 900, outputTokens: 100 })).toBe("1.0k tok")
  })

  it("never rounds a real cost down to nothing", () => {
    expect(formatUsd(0.004)).toBe("<$0.01")
    expect(formatUsd(0)).toBe("$0.00")
  })

  it("scales token counts", () => {
    expect(formatTokens(940)).toBe("940")
    expect(formatTokens(18400)).toBe("18k")
    expect(formatTokens(2_400_000)).toBe("2.4M")
  })

  it("adds the turn count to a session total", () => {
    expect(formatSessionUsage({ turns: 1, costUsd: 0.06 })).toBe(
      "$0.06 · 1 turn",
    )
  })
})
