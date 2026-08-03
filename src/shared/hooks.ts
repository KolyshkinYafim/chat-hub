/** Events a project-local `.chathub/hooks/*.json` file may subscribe to. */
export type HookTrigger =
  | "session_start"
  | "turn_done"
  | "file_save"
  | "pre_tool_use"
  | "post_tool_use"

export const HOOK_TRIGGERS: readonly HookTrigger[] = [
  "session_start",
  "turn_done",
  "file_save",
  "pre_tool_use",
  "post_tool_use",
] as const

export type HookAction =
  | { kind: "prompt"; value: string }
  | { kind: "shell"; value: string }

/** Validated on-disk hook definition (filename stem becomes `name`). */
export type HookDefinition = {
  name: string
  trigger: HookTrigger
  /** Optional regex against a file path — only meaningful for file/tool triggers. */
  match?: string
  action: HookAction
  /** ms; defaults to 30s when omitted on disk. */
  timeout: number
  enabled: boolean
}

export type HookRunStatus = "ok" | "error" | "timeout"

/** One execution of one hook, published to the renderer via `hook.ran`. */
export type HookRun = {
  id: string
  sessionId: string
  hookName: string
  trigger: HookTrigger
  startedAt: number
  finishedAt: number
  status: HookRunStatus
  /** Shell stdout/stderr, exit code note, or prompt-queue note. */
  output?: string
  exitCode?: number
}

export type HookRunContext = {
  /** File path for match-filtered triggers. */
  file?: string
}
