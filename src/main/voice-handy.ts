import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

/**
 * Handy (https://handy.computer) is a local dictation app: a global hotkey (or
 * these flags) toggles recording, and Handy itself pastes the transcription
 * into the focused field. Chat Hub never touches audio — it only pokes the
 * running instance, which forwards single-flag invocations of its binary over
 * its single-instance socket.
 */
export const HANDY_BINARY = "/Applications/Handy.app/Contents/MacOS/handy"

export const HANDY_TOGGLE_ARGS = ["--toggle-transcription"] as const
export const HANDY_CANCEL_ARGS = ["--cancel"] as const

/**
 * `open -a` instead of spawning the binary: launches the real app bundle.
 * `-g` keeps Handy in the background — without it macOS activates Handy's
 * window, Chat Hub blurs, and the eventual paste follows focus out of the
 * composer.
 */
export const HANDY_LAUNCH = {
  command: "open",
  args: ["-g", "-a", "Handy"],
} as const

export const HANDY_RUNNING_PROBE = {
  command: "pgrep",
  args: ["-x", "handy"],
} as const

const LAUNCH_RETRIES = 10
const LAUNCH_RETRY_MS = 250

export interface HandyDeps {
  exists: (path: string) => boolean
  /** Resolves exit-0 truth; a spawn failure is `false`, never a rejection. */
  run: (command: string, args: readonly string[]) => Promise<boolean>
  delay: (ms: number) => Promise<void>
}

const defaultDeps: HandyDeps = {
  exists: existsSync,
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, [...args], (error) => resolve(!error))
    }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function handyInstalled(deps: HandyDeps = defaultDeps): boolean {
  return deps.exists(HANDY_BINARY)
}

export function handyRunning(deps: HandyDeps = defaultDeps): Promise<boolean> {
  return deps.run(HANDY_RUNNING_PROBE.command, HANDY_RUNNING_PROBE.args)
}

/** Launch Handy if installed but dead, and wait until its process shows up. */
export async function ensureHandyRunning(
  deps: HandyDeps = defaultDeps,
): Promise<boolean> {
  if (!handyInstalled(deps)) return false
  if (await handyRunning(deps)) return true
  if (!(await deps.run(HANDY_LAUNCH.command, HANDY_LAUNCH.args))) return false
  for (let attempt = 0; attempt < LAUNCH_RETRIES; attempt++) {
    await deps.delay(LAUNCH_RETRY_MS)
    if (await handyRunning(deps)) return true
  }
  return false
}

export type VoiceToggleIntent = "start" | "stop"

/**
 * Start or stop dictation. Resolves `false` when Handy is missing, will not
 * come up, or refused the flag — the renderer keeps its button honest on that.
 *
 * The intent matters when Handy died mid-take: "start" may boot it, but
 * "stop" must not — a fresh instance would read the toggle as a start and
 * record with the UI showing idle. A dead Handy on the stop path means the
 * take is already gone, so it reports failure instead of launching anything.
 */
export async function toggleHandyTranscription(
  intent: VoiceToggleIntent,
  deps: HandyDeps = defaultDeps,
): Promise<boolean> {
  if (intent === "stop") {
    if (!handyInstalled(deps)) return false
    if (!(await handyRunning(deps))) return false
    return deps.run(HANDY_BINARY, HANDY_TOGGLE_ARGS)
  }
  if (!(await ensureHandyRunning(deps))) return false
  return deps.run(HANDY_BINARY, HANDY_TOGGLE_ARGS)
}

/**
 * Abort an in-flight recording. When no instance is running there is nothing
 * to cancel — and spawning the binary then would *launch* Handy, so don't.
 */
export async function cancelHandyTranscription(
  deps: HandyDeps = defaultDeps,
): Promise<boolean> {
  if (!handyInstalled(deps)) return true
  if (!(await handyRunning(deps))) return true
  return deps.run(HANDY_BINARY, HANDY_CANCEL_ARGS)
}
