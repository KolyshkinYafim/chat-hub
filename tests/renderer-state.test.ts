import { describe, expect, it } from "vitest"
import {
  actionForPath,
  collectAgentActions,
  editedPathsInMessage,
} from "@renderer/lib/agent-actions"
import { mergeReplacedMessages } from "@renderer/lib/transcript-window"
import {
  parseArchived,
  pruneArchived,
  serializeArchived,
} from "@renderer/lib/archive"
import {
  buildTranscript,
  planProgress,
  type ToolCall,
  type TranscriptBlock,
} from "@renderer/lib/tool-runs"
import {
  formatSessionUsage,
  formatTokens,
  formatUsage,
  formatUsd,
} from "@renderer/lib/usage"
import type { ChatMessage } from "@shared/types"
import { encodeToolCardMeta, type PlanStep } from "@shared/tool-card"
import { groupHookBanners } from "@renderer/lib/hook-banners"
import type { HookRun } from "@shared/hooks"
import { toolUseBlock } from "../src/main/adapters/stream-parse"
import { toPlanSteps } from "@renderer/components/PlanSteps"

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

describe("plan checklist blocks", () => {
  it("surfaces TodoWrite as a plan block, not a tool run", () => {
    const md = toolUseBlock("TodoWrite", {
      todos: [
        { content: "One", status: "completed" },
        { content: "Two", status: "in_progress" },
      ],
    })
    const { blocks } = buildTranscript(md)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: "plan",
      name: "TodoWrite",
    })
    const plan = (blocks[0] as { meta: { plan?: PlanStep[] } }).meta.plan
    expect(plan).toHaveLength(2)
    expect(plan?.[1]?.status).toBe("in_progress")
  })

  it("does not crash on an empty plan list", () => {
    const meta = encodeToolCardMeta({ plan: [] })
    // No plan steps → falls back to a plain tool block (or empty plan card path).
    const { blocks } = buildTranscript(`\`\`\`tool:TodoWrite\n${meta}\n\`\`\``)
    // Empty plan array is omitted from encode → generic tool card is fine.
    expect(blocks.length).toBeGreaterThanOrEqual(1)
  })

  it("maps progress labels for Step N/M", () => {
    const steps: PlanStep[] = [
      { text: "a", status: "completed" },
      { text: "b", status: "in_progress" },
      { text: "c", status: "pending" },
    ]
    expect(planProgress(steps)).toEqual({ current: 2, total: 3 })
    expect(planProgress([])).toEqual({ current: 0, total: 0 })
    expect(planProgress([{ text: "x", status: "completed" }])).toEqual({
      current: 1,
      total: 1,
    })
  })

  it("maps turn-item running status onto in_progress", () => {
    expect(
      toPlanSteps([
        { text: "a", status: "running" },
        { text: "b", status: "completed" },
      ]),
    ).toEqual([
      { text: "a", status: "in_progress" },
      { text: "b", status: "completed" },
    ])
    expect(toPlanSteps(undefined)).toEqual([])
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

  it("classifies a mermaid fence as kind mermaid, not code", () => {
    const src =
      "Here is the flow:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nDone."
    const { blocks } = buildTranscript(src)
    expect(blocks).toEqual([
      { kind: "p", text: "Here is the flow:" },
      { kind: "mermaid", code: "flowchart LR\n  A --> B" },
      { kind: "p", text: "Done." },
    ])
  })

  it("keeps non-mermaid fences as code", () => {
    const { blocks } = buildTranscript("```ts\nconst x = 1\n```")
    expect(blocks).toEqual([{ kind: "code", lang: "ts", code: "const x = 1" }])
  })
})

describe("agent audit trail", () => {
  function msg(
    id: string,
    content: string,
    role: ChatMessage["role"] = "assistant",
  ): ChatMessage {
    return {
      id,
      sessionId: "s1",
      role,
      content,
      createdAt: 1,
    }
  }

  it("returns an empty list when the turn has not run yet", () => {
    expect(collectAgentActions([])).toEqual([])
    expect(collectAgentActions([msg("u1", "hi", "user")])).toEqual([])
  })

  it("collects tool calls from assistant messages", () => {
    const meta = encodeToolCardMeta({
      paths: ["src/a.ts"],
      exitCode: 0,
    })
    const content =
      "```tool:Read\nsrc/a.ts\n```\n" +
      "```tool:Bash\npnpm test\n```\n" +
      "```tool-result:Bash\n" +
      meta +
      "ok\n```"
    const actions = collectAgentActions([msg("m1", content)])
    expect(actions.length).toBeGreaterThanOrEqual(2)
    expect(actions.some((a) => a.name === "Read")).toBe(true)
    expect(actions.some((a) => a.name === "Bash")).toBe(true)
  })

  it("collects structured Codex activity even when its prose has no tool fence", () => {
    const actions = collectAgentActions([{
      ...msg("m1", "Finished."),
      items: [
        { id: "cmd-1", kind: "command", status: "completed", command: "pnpm test", exitCode: 0 },
        { id: "edit-1", kind: "file_change", status: "completed", changes: [{ path: "src/a.ts", kind: "edit" }] },
      ],
    }])
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Command", summary: "$ pnpm test", exitCode: 0 }),
      expect.objectContaining({ name: "File change", paths: ["src/a.ts"] }),
    ]))
  })

  it("links a path only when the trail already knows it", () => {
    const actions = collectAgentActions([
      msg(
        "m1",
        "```tool:Edit\n" +
          encodeToolCardMeta({ paths: ["src/foo.ts"] }) +
          "src/foo.ts\n```",
      ),
    ])
    expect(actionForPath(actions, "src/foo.ts")?.name).toBe("Edit")
    expect(actionForPath(actions, "src/other.ts")).toBeNull()
  })

  it("derives edited paths from the same parse the transcript draws", () => {
    const content =
      "```tool:Read\n" +
      encodeToolCardMeta({ id: "r1" }) +
      "src/read-only.ts\n```\n" +
      "```tool:Edit\n" +
      encodeToolCardMeta({ id: "e1", paths: ["src/foo.ts"], added: 2, removed: 1 }) +
      "src/foo.ts\n```\n" +
      "```tool:Write\n" +
      encodeToolCardMeta({ id: "w1", paths: ["src/foo.ts"] }) +
      "src/foo.ts\n```"
    expect(editedPathsInMessage(msg("m1", content))).toEqual(["src/foo.ts"])
  })

  it("counts a Codex file_change item and ignores a viewed image", () => {
    const message: ChatMessage = {
      ...msg("m1", "Done."),
      items: [
        {
          id: "edit-1",
          kind: "file_change",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "edit" }],
        },
        { id: "img-1", kind: "image", status: "completed", path: "shot.png" },
      ],
    }
    expect(editedPathsInMessage(message)).toEqual(["src/a.ts"])
  })

  it("reports nothing for a turn that only read and ran commands", () => {
    expect(editedPathsInMessage(msg("m1", "just prose"))).toEqual([])
    expect(
      editedPathsInMessage(msg("m1", "```tool:Bash\npnpm test\n```")),
    ).toEqual([])
  })
})

describe("transcript window merge", () => {
  function msg(id: string): ChatMessage {
    return { id, sessionId: "s1", role: "assistant", content: id, createdAt: 1 }
  }

  it("keeps archive pages sitting in front of the live window", () => {
    const existing = [msg("old-1"), msg("old-2"), msg("live-1"), msg("live-2")]
    const replacement = [msg("live-1"), msg("live-2"), msg("live-3")]
    expect(
      mergeReplacedMessages(existing, replacement).map((m) => m.id),
    ).toEqual(["old-1", "old-2", "live-1", "live-2", "live-3"])
  })

  it("takes the replacement whole when nothing older is held", () => {
    const replacement = [msg("live-1")]
    expect(mergeReplacedMessages([], replacement)).toEqual(replacement)
    expect(mergeReplacedMessages([msg("live-1")], replacement)).toEqual(
      replacement,
    )
  })

  it("takes the replacement whole when the two lists share nothing", () => {
    const existing = [msg("gone-1")]
    const replacement = [msg("live-1")]
    expect(mergeReplacedMessages(existing, replacement)).toEqual(replacement)
    expect(mergeReplacedMessages(existing, [])).toEqual([])
  })
})

describe("hook terminal banners", () => {
  function run(over: Partial<HookRun>): HookRun {
    return {
      id: over.id ?? "r1",
      sessionId: "s1",
      hookName: over.hookName ?? "h",
      trigger: over.trigger ?? "session_start",
      startedAt: over.startedAt ?? 1000,
      finishedAt: over.finishedAt ?? 1100,
      status: over.status ?? "ok",
      ...over,
    }
  }

  it("groups same-trigger runs into one banner with a count", () => {
    const banners = groupHookBanners([
      run({ id: "1", trigger: "session_start", startedAt: 1000, hookName: "a" }),
      run({ id: "2", trigger: "session_start", startedAt: 1001, hookName: "b" }),
      run({ id: "3", trigger: "session_start", startedAt: 1002, hookName: "c" }),
    ])
    expect(banners).toHaveLength(1)
    expect(banners[0]).toMatchObject({
      trigger: "session_start",
      count: 3,
    })
  })

  it("splits banners when the trigger changes", () => {
    const banners = groupHookBanners([
      run({ id: "1", trigger: "session_start", startedAt: 1000 }),
      run({ id: "2", trigger: "turn_done", startedAt: 1001 }),
    ])
    expect(banners.map((b) => b.trigger)).toEqual([
      "session_start",
      "turn_done",
    ])
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
