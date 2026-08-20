import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

export type DirStats = { bytes: number; files: number }

/**
 * Recursive size of a folder. Async on purpose: the data folder holds every
 * archived transcript, and a synchronous walk of it would freeze the window.
 *
 * Symlinks are counted as entries but never followed — the folder can hold a
 * link back into itself, and a size report is not worth an infinite walk.
 */
export async function dirStats(dir: string): Promise<DirStats> {
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, files: 0 }
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      files += 1
      continue
    }
    if (entry.isDirectory()) {
      const sub = await dirStats(full)
      bytes += sub.bytes
      files += sub.files
      continue
    }
    try {
      bytes += (await lstat(full)).size
      files += 1
    } catch {
      /* vanished mid-walk — the folder is live while we read it */
    }
  }
  return { bytes, files }
}
