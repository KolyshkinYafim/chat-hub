import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

const queues = new Map<string, Promise<unknown>>()
let counter = 0

/**
 * Crash-safe write for the JSON stores. Two overlapping saves used to share one
 * `<file>.tmp`: both truncated it at offset 0 and the shorter one won the rename,
 * publishing a torn document that the next boot silently read as "empty" — every
 * session, key or project gone. Serialise per path and give each attempt its own
 * tmp name so an overlap can no longer interleave.
 */
export function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const prev = queues.get(filePath) ?? Promise.resolve()
  const run = prev.then(
    () => writeOnce(filePath, data),
    () => writeOnce(filePath, data),
  )
  // The chain must survive a rejected save, but the caller still sees the error.
  queues.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

async function writeOnce(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${++counter}.tmp`
  try {
    const handle = await open(tmp, "w")
    try {
      await handle.writeFile(data, "utf8")
      // rename must publish bytes that already reached disk — app.exit() after a
      // quit-flush gives the page cache no chance to catch up.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * Park a store we could not parse instead of letting the next save overwrite it —
 * a corrupt file is still the only copy of the user's data.
 */
export async function quarantineCorrupt(filePath: string): Promise<string | null> {
  const parked = `${filePath}.corrupt-${Date.now()}`
  try {
    await rename(filePath, parked)
    return parked
  } catch {
    return null
  }
}
