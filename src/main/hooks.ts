import { exec } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  HOOK_TRIGGERS,
  type HookAction,
  type HookDefinition,
  type HookRun,
  type HookRunContext,
  type HookTrigger,
} from "@shared/hooks"
import type { EventBus } from "./event-bus"

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

const TRIGGER_SET = new Set<string>(HOOK_TRIGGERS)

export type HookPromptHandler = (
  sessionId: string,
  text: string,
) => void | Promise<void>

type SessionHooks = {
  cwd: string
  hooks: HookDefinition[]
}

/**
 * Project-local hooks: `.chathub/hooks/*.json` in the session cwd.
 * Loads once per session, matches by trigger (+ optional path regex), runs
 * shell/prompt actions, and publishes each result as `hook.ran`.
 */
export class HookRunner {
  private bySession = new Map<string, SessionHooks>()

  constructor(
    private readonly bus: EventBus,
    private readonly enqueuePrompt: HookPromptHandler,
  ) {}

  /** Read and validate hooks for a session. Safe on a missing dir. */
  async loadForSession(sessionId: string, cwd: string): Promise<HookDefinition[]> {
    const hooks = await loadHooksFromCwd(cwd)
    this.bySession.set(sessionId, { cwd, hooks })
    return hooks
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /**
   * Run every enabled hook matching `trigger` (and `ctx.file` when a `match`
   * regex is set). Never throws — failures become HookRun status "error".
   * Each finished run is published immediately so the terminal can update live.
   */
  async run(
    sessionId: string,
    trigger: HookTrigger,
    ctx: HookRunContext = {},
  ): Promise<HookRun[]> {
    const entry = this.bySession.get(sessionId)
    if (!entry) return []

    const matched = entry.hooks.filter((h) => hookMatches(h, trigger, ctx.file))
    const runs: HookRun[] = []
    for (const hook of matched) {
      const run = await this.execute(sessionId, entry.cwd, hook)
      runs.push(run)
      this.bus.emit({ type: "hook.ran", run })
    }
    return runs
  }

  private async execute(
    sessionId: string,
    cwd: string,
    hook: HookDefinition,
  ): Promise<HookRun> {
    const startedAt = Date.now()
    const base = {
      id: randomUUID(),
      sessionId,
      hookName: hook.name,
      trigger: hook.trigger,
      startedAt,
    }

    try {
      if (hook.action.kind === "prompt") {
        const text = hook.action.value.trim()
        if (!text) {
          return {
            ...base,
            finishedAt: Date.now(),
            status: "error",
            output: "empty prompt",
          }
        }
        await this.enqueuePrompt(sessionId, text)
        return {
          ...base,
          finishedAt: Date.now(),
          status: "ok",
          output: "queued prompt",
        }
      }

      const result = await runShell(hook.action.value, cwd, hook.timeout)
      return {
        ...base,
        finishedAt: Date.now(),
        status: result.status,
        output: result.output,
        exitCode: result.exitCode,
      }
    } catch (err) {
      return {
        ...base,
        finishedAt: Date.now(),
        status: "error",
        output: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

/** True when the hook should fire for this trigger (+ optional path match). */
export function hookMatches(
  hook: HookDefinition,
  trigger: HookTrigger,
  file?: string,
): boolean {
  if (!hook.enabled) return false
  if (hook.trigger !== trigger) return false
  if (!hook.match) return true
  // Match is only meaningful when we have a path; no path → no match.
  if (file === undefined || file === "") return false
  try {
    return new RegExp(hook.match).test(file)
  } catch {
    return false
  }
}

/**
 * Parse one on-disk JSON blob into a HookDefinition, or null if invalid.
 * `name` is the filename stem (e.g. `lint` for `lint.json`).
 */
export function parseHookDefinition(
  name: string,
  raw: string,
): HookDefinition | null {
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>

  const trigger = obj.trigger
  if (typeof trigger !== "string" || !TRIGGER_SET.has(trigger)) return null

  const action = parseAction(obj.action)
  if (!action) return null

  let match: string | undefined
  if (obj.match !== undefined) {
    if (typeof obj.match !== "string" || obj.match.length === 0) return null
    try {
      // Reject invalid regex early so a bad file never reaches run-time.
      void new RegExp(obj.match)
    } catch {
      return null
    }
    match = obj.match
  }

  let timeout = DEFAULT_HOOK_TIMEOUT_MS
  if (obj.timeout !== undefined) {
    if (typeof obj.timeout !== "number" || !Number.isFinite(obj.timeout) || obj.timeout < 0) {
      return null
    }
    timeout = Math.floor(obj.timeout)
  }

  const enabled = obj.enabled === undefined ? true : obj.enabled === true

  const def: HookDefinition = {
    name,
    trigger: trigger as HookTrigger,
    action,
    timeout,
    enabled,
  }
  if (match !== undefined) def.match = match
  return def
}

function parseAction(raw: unknown): HookAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  const value = obj.value
  if (kind !== "prompt" && kind !== "shell") return null
  if (typeof value !== "string") return null
  return { kind, value }
}

/** Load every `*.json` under `.chathub/hooks/`. Skips unreadable/invalid files. */
export async function loadHooksFromCwd(cwd: string): Promise<HookDefinition[]> {
  const dir = join(cwd, ".chathub", "hooks")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const out: HookDefinition[] = []
  for (const file of names) {
    if (!file.endsWith(".json")) continue
    const stem = file.slice(0, -".json".length)
    if (!stem) continue
    let raw: string
    try {
      raw = await readFile(join(dir, file), "utf8")
    } catch {
      continue
    }
    const def = parseHookDefinition(stem, raw)
    if (def) out.push(def)
  }
  // Stable order: filename stem, so UI/tests are deterministic.
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

type ShellResult = {
  status: "ok" | "error" | "timeout"
  output: string
  exitCode?: number
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const out = [stdout, stderr]
          .map((s) => (typeof s === "string" ? s : ""))
          .join("")
          .trim()
        if (!err) {
          resolve({ status: "ok", output: out, exitCode: 0 })
          return
        }
        // node:child_process sets killed=true when the timeout timer fires.
        const killed =
          "killed" in err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed
        const code =
          "code" in err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : undefined
        if (killed || (err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          resolve({
            status: "timeout",
            output: out || err.message,
            exitCode: code,
          })
          return
        }
        resolve({
          status: "error",
          output: out || err.message,
          exitCode: code,
        })
      },
    )
  })
}
