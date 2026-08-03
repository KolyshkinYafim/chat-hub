import { describe, expect, it } from "vitest"
import {
  parseArchived,
  pruneArchived,
  serializeArchived,
} from "@renderer/lib/archive"
import {
  buildTranscript,
  type ToolCall,
  type TranscriptBlock,
} from "@renderer/lib/tool-runs"
import {
  formatSessionUsage,
  formatTokens,
  formatUsage,
  formatUsd,
} from "@renderer/lib/usage"

function onlyCall(block: TranscriptBlock | undefined): ToolCall {
  if (!block || block.kind !== "tools" || block.calls.length !== 1) {
    throw new Error(`expected one tool call, got ${JSON.stringify(block)}`)
  }
  return block.calls[0]!
}

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
    const { blocks } = buildTranscript(
      "```tool:Edit\nsrc/a.ts\n```\n```diff\n-old\n+new\n```",
    )
    expect(blocks).toHaveLength(1)
    const call = onlyCall(blocks[0])
    expect(call.name).toBe("Edit")
    expect(call.diff).toBe("-old\n+new")
  })

  it("folds a tool-result into its call but leaves prose alone", () => {
    const { blocks } = buildTranscript(
      "```tool:Bash\npnpm test\n```\n```tool-result:Bash\n2 passed\n```\nAll green.",
    )
    expect(blocks).toHaveLength(2)
    expect(onlyCall(blocks[0]).result?.text).toBe("2 passed")
    expect(blocks[1]).toMatchObject({ kind: "p" })
  })

  it("does not attach a diff that follows a result rather than a call", () => {
    const { blocks } = buildTranscript(
      "```tool-result:Bash\nboom\n```\n```diff\n+x\n```",
    )
    expect(blocks).toHaveLength(2)
    expect(onlyCall(blocks[0]).diff).toBeNull()
    expect(blocks[1]).toMatchObject({ kind: "diff" })
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
