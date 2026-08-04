import {
  claudePermissionArgs,
  grokPermissionArgs,
  opencodeSkipPermissions,
  type PermissionMode,
} from "@shared/permission"
import type { EffortLevel } from "./types"


export type ArgvOpts = {
  message: string
  cwd: string
  permissionMode: PermissionMode
  model?: string
  effort?: EffortLevel
  /** Absolute local file paths picked in the composer. */
  attachments?: string[]
  /** Mode preset system prompt, appended to the CLI's own (Claude only). */
  systemPrompt?: string
  /** CLI-native session id to continue. */
  resumeId?: string
}

/**
 * Fold attachments into the prompt text. Claude and Codex have no flag that
 * takes a local path (Claude's `--file` wants `file_id:relative_path` uploads
 * and drops anything without a colon), so the paths have to travel as text.
 */
export function promptWithAttachments(
  message: string,
  attachments?: string[],
): string {
  if (!attachments?.length) return message
  const list = attachments.map((p) => `@${p}`).join("\n")
  const head = message.trim() || "Review the attached files."
  return `${head}\n\nAttached files:\n${list}`
}

export function buildClaudeArgs(o: ArgvOpts): string[] {
  const args = [
    "-p",
    promptWithAttachments(o.message, o.attachments),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Default YOLO: full bypass for unattended daily coding
    ...claudePermissionArgs(o.permissionMode),
  ]
  if (o.model) args.push("--model", o.model)
  if (o.effort) args.push("--effort", o.effort)
  if (o.systemPrompt?.trim()) {
    args.push("--append-system-prompt", o.systemPrompt.trim())
  }
  if (o.resumeId) args.push("--resume", o.resumeId)
  return args
}

export function buildGrokArgs(o: ArgvOpts): string[] {
  const args = [
    "--single",
    promptWithAttachments(o.message, o.attachments),
    "--output-format",
    "streaming-json",
    "--cwd",
    o.cwd,
    ...grokPermissionArgs(o.permissionMode),
  ]
  if (o.model) args.push("--model", o.model)
  if (o.effort) args.push("--reasoning-effort", o.effort)
  if (o.systemPrompt?.trim()) args.push("--rules", o.systemPrompt.trim())
  if (o.resumeId) args.push("--resume", o.resumeId)
  return args
}

export function buildOpenCodeArgs(o: ArgvOpts): string[] {
  // opencode's own `-f/--file` takes local paths, so attachments stay a flag.
  const args = ["run", o.message, "--format", "json", "--dir", o.cwd]
  if (o.model) args.push("--model", o.model)
  for (const f of o.attachments ?? []) args.push("--file", f)
  if (o.resumeId) args.push("--session", o.resumeId)
  // OpenCode 1.x renamed the old --auto surface.  Its replacement is a full
  // bypass, so it maps only to YOLO; the Edits chip stays safe and lets the
  // CLI ask rather than silently granting shell/network access.
  if (opencodeSkipPermissions(o.permissionMode)) {
    args.push("--dangerously-skip-permissions")
  }
  if (o.effort) args.push("--variant", o.effort)
  return args
}

export function buildCodexArgs(o: ArgvOpts): string[] {
  const prompt = promptWithAttachments(o.message, o.attachments)
  // `exec resume` is a subcommand with its own, much smaller flag set: it
  // rejects --cd/--sandbox/--add-dir outright ("unexpected argument '-C'"), so
  // a resumed turn takes its working directory from the spawn's cwd instead.
  const args = o.resumeId
    ? ["exec", "resume", o.resumeId, prompt]
    : ["exec", prompt, "--cd", o.cwd]

  // Verified against codex-cli 0.146.0: stdout is clean JSONL, log lines go to
  // stderr. Without it the transcript gets the human TUI rendering.
  args.push("--json")
  // Chat Hub opens sessions on any folder; codex refuses non-repo cwds by default.
  args.push("--skip-git-repo-check")
  if (o.model) args.push("--model", o.model)

  if (o.permissionMode === "yolo") {
    // --full-auto is deprecated and only means `--sandbox workspace-write`, so
    // it would quietly under-deliver the "full access" the chip promises.
    args.push("--dangerously-bypass-approvals-and-sandbox")
  } else if (!o.resumeId) {
    // resume takes no --sandbox; a resumed non-yolo turn keeps the CLI default.
    args.push("--sandbox", o.permissionMode === "acceptEdits" ? "workspace-write" : "read-only")
  }
  return args
}
