import { describe, expect, it } from "vitest"
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildOpenCodeArgs,
  promptWithAttachments,
} from "../src/main/adapters/args"

const base = {
  message: "refactor the parser",
  cwd: "/Users/me/code/mary",
  permissionMode: "yolo" as const,
}

/** Value of the flag that follows `name`, or undefined if the flag is absent. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

describe("promptWithAttachments", () => {
  it("leaves the prompt alone when nothing is attached", () => {
    expect(promptWithAttachments("hi", [])).toBe("hi")
    expect(promptWithAttachments("hi")).toBe("hi")
  })

  it("carries absolute paths as @mentions the CLI can resolve", () => {
    const out = promptWithAttachments("review this", [
      "/Users/me/code/mary/src/api.ts",
    ])
    expect(out).toContain("review this")
    expect(out).toContain("@/Users/me/code/mary/src/api.ts")
  })

  it("still asks for something when the composer sent attachments only", () => {
    const out = promptWithAttachments("   ", ["/tmp/a.png"])
    expect(out.startsWith("Review the attached files.")).toBe(true)
    expect(out).toContain("@/tmp/a.png")
  })

  it("keeps a path with spaces in one argument", () => {
    const out = promptWithAttachments("look", ["/Users/me/My Docs/a b.ts"])
    expect(out).toContain("@/Users/me/My Docs/a b.ts")
  })
})

describe("buildClaudeArgs", () => {
  it("streams partial messages in stream-json, prompt first", () => {
    const args = buildClaudeArgs(base)
    expect(args[0]).toBe("-p")
    expect(args[1]).toBe("refactor the parser")
    expect(flag(args, "--output-format")).toBe("stream-json")
    expect(args).toContain("--verbose")
    expect(args).toContain("--include-partial-messages")
  })

  it("never passes --file: Claude 2.x wants file_id:relative_path uploads", () => {
    const args = buildClaudeArgs({
      ...base,
      attachments: ["/Users/me/code/mary/src/api.ts"],
    })
    expect(args).not.toContain("--file")
    expect(args[1]).toContain("@/Users/me/code/mary/src/api.ts")
  })

  it("omits --permission-mode for Ask — `default` is not a valid choice", () => {
    const args = buildClaudeArgs({ ...base, permissionMode: "default" })
    expect(args).not.toContain("--permission-mode")
    expect(args.join(" ")).not.toContain("default")
  })

  it("bypasses permissions in YOLO and auto-accepts edits in Edits", () => {
    expect(flag(buildClaudeArgs(base), "--permission-mode")).toBe(
      "bypassPermissions",
    )
    expect(
      flag(buildClaudeArgs({ ...base, permissionMode: "acceptEdits" }), "--permission-mode"),
    ).toBe("acceptEdits")
  })

  it("passes model, effort and resume only when set", () => {
    const bare = buildClaudeArgs(base)
    expect(bare).not.toContain("--model")
    expect(bare).not.toContain("--effort")
    expect(bare).not.toContain("--resume")

    const full = buildClaudeArgs({
      ...base,
      model: "opus",
      effort: "high",
      resumeId: "sid-1",
    })
    expect(flag(full, "--model")).toBe("opus")
    expect(flag(full, "--effort")).toBe("high")
    expect(flag(full, "--resume")).toBe("sid-1")
  })

  it("appends a mode's system prompt, and omits the flag when blank", () => {
    expect(buildClaudeArgs(base)).not.toContain("--append-system-prompt")
    expect(
      buildClaudeArgs({ ...base, systemPrompt: "   " }),
    ).not.toContain("--append-system-prompt")

    const withMode = buildClaudeArgs({
      ...base,
      systemPrompt: "Act as a meticulous reviewer.",
    })
    expect(flag(withMode, "--append-system-prompt")).toBe(
      "Act as a meticulous reviewer.",
    )
  })
})

describe("buildGrokArgs", () => {
  it("sends one prompt argument with the attachments folded in", () => {
    const args = buildGrokArgs({ ...base, attachments: ["/tmp/a.ts"] })
    expect(args[0]).toBe("--single")
    expect(args[1]).toContain("refactor the parser")
    expect(args[1]).toContain("@/tmp/a.ts")
    expect(args.filter((a) => a === "--single")).toHaveLength(1)
  })

  it("runs in the session cwd and resumes when it has an id", () => {
    expect(flag(buildGrokArgs(base), "--cwd")).toBe("/Users/me/code/mary")
    expect(flag(buildGrokArgs({ ...base, resumeId: "g1" }), "--resume")).toBe("g1")
    expect(
      flag(buildGrokArgs({ ...base, effort: "high" }), "--reasoning-effort"),
    ).toBe("high")
  })
})

describe("buildOpenCodeArgs", () => {
  it("keeps --file: opencode's own flag does take local paths", () => {
    const args = buildOpenCodeArgs({
      ...base,
      attachments: ["/tmp/a.ts", "/tmp/b.ts"],
    })
    expect(args.filter((a) => a === "--file")).toHaveLength(2)
    expect(args).toContain("/tmp/b.ts")
    expect(flag(args, "--dir")).toBe("/Users/me/code/mary")
    expect(flag(args, "--format")).toBe("json")
  })

  it("uses OpenCode 1.x's full bypass only for yolo", () => {
    expect(buildOpenCodeArgs(base)).toContain("--dangerously-skip-permissions")
    expect(buildOpenCodeArgs(base)).not.toContain("--auto")
    expect(
      buildOpenCodeArgs({ ...base, permissionMode: "acceptEdits" }),
    ).not.toContain("--dangerously-skip-permissions")
    expect(
      buildOpenCodeArgs({ ...base, permissionMode: "default" }),
    ).not.toContain("--dangerously-skip-permissions")
  })

  it("passes the selected effort as OpenCode's model variant", () => {
    expect(flag(buildOpenCodeArgs({ ...base, effort: "high" }), "--variant")).toBe(
      "high",
    )
  })

  it("continues an existing opencode session", () => {
    expect(flag(buildOpenCodeArgs({ ...base, resumeId: "ses_1" }), "--session")).toBe(
      "ses_1",
    )
  })
})

describe("buildCodexArgs", () => {
  it("execs the prompt in the session cwd", () => {
    const args = buildCodexArgs(base)
    expect(args[0]).toBe("exec")
    expect(args[1]).toBe("refactor the parser")
    expect(flag(args, "--cd")).toBe("/Users/me/code/mary")
  })

  // Flag surface and event shape are pinned against the real binary in
  // tests/codex-stream.test.ts; this file only covers the shared argv shape.
  it("bypasses approvals only in YOLO", () => {
    expect(buildCodexArgs(base)).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    )
    expect(buildCodexArgs({ ...base, permissionMode: "default" })).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    )
  })

  it("mentions attachments in the prompt instead of dropping them", () => {
    const args = buildCodexArgs({ ...base, attachments: ["/tmp/a.ts"] })
    expect(args[1]).toContain("@/tmp/a.ts")
  })
})
