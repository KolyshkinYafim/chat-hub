import { describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { buildTestArgs, TEST_PROMPT, readableAnswer } from "../src/main/provider-probe"
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildOpenCodeArgs,
} from "../src/main/adapters/args"

/**
 * "Test connection" used to hand-roll its own argv, which let the check drift
 * away from what a real turn does — a green button on flags production never
 * passes. These tests pin the probe to the production builders.
 * Flags checked against codex-cli 0.146.0-alpha.9.2
 * (/Applications/ChatGPT.app/Contents/Resources/codex, `codex exec --help`).
 */
describe("buildTestArgs", () => {
  const HOME = homedir()

  it("gives codex exactly what buildCodexArgs builds for a read-only turn", () => {
    expect(buildTestArgs("codex")).toEqual(
      buildCodexArgs({
        message: TEST_PROMPT,
        cwd: HOME,
        permissionMode: "default",
      }),
    )
  })

  it("never sends codex the deprecated --full-auto", () => {
    // --full-auto is only `--sandbox workspace-write` under another name, and
    // buildCodexArgs deliberately refuses it. The probe must not resurrect it.
    expect(buildTestArgs("codex")).not.toContain("--full-auto")
  })

  it("keeps the probe unprivileged: read-only sandbox, no bypass", () => {
    const args = buildTestArgs("codex")!
    expect(args.join(" ")).toContain("--sandbox read-only")
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args).not.toContain("--dangerously-bypass-hook-trust")
  })

  it("still asks codex for JSONL in a non-repo folder, with a real cwd", () => {
    const args = buildTestArgs("codex")!
    expect(args.slice(0, 2)).toEqual(["exec", TEST_PROMPT])
    expect(args).toContain("--json")
    expect(args).toContain("--skip-git-repo-check")
    expect(args.join(" ")).toContain(`--cd ${HOME}`)
  })

  it("passes the instance's default model through to codex", () => {
    expect(buildTestArgs("codex", { model: "gpt-5-codex" })!.join(" ")).toContain(
      "--model gpt-5-codex",
    )
  })

  it("matches production for claude, grok and opencode too", () => {
    const base = { message: TEST_PROMPT, cwd: HOME, permissionMode: "default" as const }
    expect(buildTestArgs("claude")).toEqual(buildClaudeArgs({ ...base, model: "haiku" }))
    expect(buildTestArgs("grok")).toEqual(buildGrokArgs(base))
    expect(buildTestArgs("opencode")).toEqual(buildOpenCodeArgs(base))
  })

  it("carries no permission bypass on any provider", () => {
    for (const p of ["claude", "grok", "opencode", "codex"] as const) {
      const joined = buildTestArgs(p)!.join(" ")
      expect(joined).not.toContain("--dangerously-skip-permissions")
      expect(joined).not.toContain("bypassPermissions")
      expect(joined).not.toContain("--always-approve")
      expect(joined).not.toContain("--auto")
      expect(joined).not.toContain("danger-full-access")
    }
  })

  it("has no test for mock (handled before argv is built)", () => {
    expect(buildTestArgs("mock")).toBeNull()
  })
})

describe("readableAnswer", () => {
  it("takes the agent message out of a codex JSONL turn", () => {
    const raw = [
      '{"type":"thread.started","thread_id":"019fc287"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":12}}',
    ].join("\n")
    expect(readableAnswer(raw)).toBe("OK")
  })

  it("takes the final result line out of a claude stream", () => {
    const raw =
      '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","result":"OK"}'
    expect(readableAnswer(raw)).toBe("OK")
  })

  it("returns null for plain text so the caller falls back to the raw tail", () => {
    expect(readableAnswer("command not found: codex")).toBeNull()
    expect(readableAnswer("")).toBeNull()
  })
})
