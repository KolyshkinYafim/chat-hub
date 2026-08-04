import { statSync } from "node:fs"
import { basename, extname } from "node:path"
import type { MessageAttachment } from "@shared/types"

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
}

/** Validate paths and derive all persisted attachment metadata in main. */
export function inspectAttachmentPaths(paths: readonly string[]): MessageAttachment[] {
  const seen = new Set<string>()
  const attachments: MessageAttachment[] = []
  for (const path of paths) {
    if (!path || path.startsWith("-") || seen.has(path)) continue
    seen.add(path)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      const mime = IMAGE_MIME[extname(path).toLowerCase()]
      attachments.push({
        path,
        name: basename(path),
        sizeBytes: stat.size,
        kind: mime ? "image" : "file",
        ...(mime ? { mime } : {}),
      })
    } catch {
      // A picker/drop can race a move or delete. Invalid paths never reach state.
    }
  }
  return attachments
}
