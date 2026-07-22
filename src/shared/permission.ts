/**
 * Hub permission policy for agent CLIs.
 * Default is YOLO (bypass) — daily coding without stop-the-world prompts.
 */
export type PermissionMode = "yolo" | "acceptEdits" | "default"

export const DEFAULT_PERMISSION_MODE: PermissionMode = "yolo"

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  yolo: "YOLO",
  acceptEdits: "Edits",
  default: "Ask",
}

export const PERMISSION_HINTS: Record<PermissionMode, string> = {
  yolo: "Bypass all tool permission prompts (full access)",
  acceptEdits: "Auto-accept file edits; still ask for risky shell",
  default: "CLI default / ask on tools",
}

/** Claude Code CLI flags for a mode. */
export function claudePermissionArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case "yolo":
      // Both flags for maximum compatibility across Claude Code versions
      return [
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
      ]
    case "acceptEdits":
      return ["--permission-mode", "acceptEdits"]
    default:
      return ["--permission-mode", "default"]
  }
}

/** Grok Build CLI flags. */
export function grokPermissionArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case "yolo":
      return ["--permission-mode", "bypassPermissions", "--always-approve"]
    case "acceptEdits":
      return ["--permission-mode", "acceptEdits"]
    default:
      return ["--permission-mode", "default"]
  }
}

/** Whether OpenCode should pass --auto. */
export function opencodeAutoApprove(mode: PermissionMode): boolean {
  return mode === "yolo" || mode === "acceptEdits"
}
