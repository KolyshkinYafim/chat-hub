import { open, stat, unlink } from "node:fs/promises"

/**
 * Cross-language advisory lock for the shared JSONL bridge.
 *
 * Three processes write that file: this app, the Swift island (which trims it)
 * and the Python hooks. Node has no `flock` — `fs.constants.O_EXLOCK` is
 * undefined on the Node builds we ship against — so the one primitive all three
 * languages agree on is an exclusive create of a sibling lock file.
 *
 * The protocol is documented in session-monitor/docs/bridge.md; changing it
 * here alone breaks the island's trimmer.
 *
 * Fail-open on purpose: a wedged lock must never stop the bridge. Losing the
 * odd status line to a concurrent trim is a cosmetic bug; blocking an agent's
 * turn behind a stale lock file is not.
 */
const STALE_MS = 5_000
const WAIT_MS = 1_500
const RETRY_MS = 25

export function lockPathFor(filePath: string): string {
  return `${filePath}.lock`
}

async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    // wx = O_CREAT | O_EXCL: atomic on every POSIX filesystem, and the same
    // thing the Swift side does with O_CREAT|O_EXCL.
    const handle = await open(lockPath, "wx")
    await handle.close()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    return false
  }
}

async function breakIfStale(lockPath: string): Promise<void> {
  try {
    const age = Date.now() - (await stat(lockPath)).mtimeMs
    if (age > STALE_MS) await unlink(lockPath)
  } catch {
    // Gone already, or not ours to judge — the next acquire attempt decides.
  }
}

/**
 * Run `fn` holding the bridge lock, or without it if the lock cannot be taken
 * within WAIT_MS. Returns whether the lock was actually held, so callers that
 * care (the trimmer) can skip a destructive rewrite they cannot do safely.
 */
export async function withBridgeLock<T>(
  filePath: string,
  fn: (locked: boolean) => Promise<T>,
): Promise<T> {
  const lockPath = lockPathFor(filePath)
  const deadline = Date.now() + WAIT_MS
  let locked = false

  while (Date.now() < deadline) {
    if (await tryAcquire(lockPath)) {
      locked = true
      break
    }
    await breakIfStale(lockPath)
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }

  try {
    return await fn(locked)
  } finally {
    if (locked) await unlink(lockPath).catch(() => {})
  }
}
