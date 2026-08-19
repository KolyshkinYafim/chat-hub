import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { dirname } from "node:path"

const DEFAULT_MAX_BYTES = 512 * 1024

export type MainLogEvent =
  | "developer.menu-installed"
  | "developer.toggle-devtools"
  | "developer.reload"
  | "developer.force-reload"
  | "developer.reveal-main-log"
  | "developer.inspect-renderer"
  | "developer.inspect-guest"

export type MainLog = {
  readonly path: string
  write: (event: MainLogEvent) => void
}

export type MainLogOptions = {
  maxBytes?: number
  now?: () => Date
}

/**
 * Defense in depth for future call sites. The current logger accepts only a
 * fixed event vocabulary and deliberately never receives prompts, URLs,
 * session state or provider output.
 */
export function redactSensitive(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|password|secret|token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number): void {
  let currentBytes: number
  try {
    currentBytes = statSync(path).size
  } catch {
    return
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) return

  const backup = `${path}.1`
  rmSync(backup, { force: true })
  renameSync(path, backup)
}

export function createMainLog(path: string, options: MainLogOptions = {}): MainLog {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
  const now = options.now ?? (() => new Date())
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!existsSync(path)) appendFileSync(path, "", { mode: 0o600 })
  // Existing installations may have created this file under a broader umask.
  chmodSync(path, 0o600)

  return {
    path,
    write(event) {
      const line = redactSensitive(`${now().toISOString()} ${event}\n`)
      rotateIfNeeded(path, Buffer.byteLength(line), maxBytes)
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 })
      chmodSync(path, 0o600)
    },
  }
}
