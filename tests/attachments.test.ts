import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { inspectAttachmentPaths } from "../src/main/attachments"
import {
  clampZoom,
  formatAttachmentSize,
  imageAttachments,
  wrappedIndex,
} from "../src/renderer/src/lib/attachments"

describe("attachment metadata", () => {
  it("derives safe persisted metadata, filters invalid paths and removes duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-attachments-"))
    const image = join(dir, "shot.PNG")
    const text = join(dir, "notes.txt")
    await writeFile(image, Buffer.alloc(1536, 1))
    await writeFile(text, "hello")

    expect(inspectAttachmentPaths([image, image, text, join(dir, "missing.png"), "--flag"]))
      .toEqual([
        {
          path: image,
          name: "shot.PNG",
          sizeBytes: 1536,
          kind: "image",
          mime: "image/png",
        },
        {
          path: text,
          name: "notes.txt",
          sizeBytes: 5,
          kind: "file",
        },
      ])
  })
})

describe("attachment gallery helpers", () => {
  it("formats compact file sizes", () => {
    expect(formatAttachmentSize(0)).toBe("0 B")
    expect(formatAttachmentSize(1536)).toBe("1.5 KB")
    expect(formatAttachmentSize(12 * 1024 * 1024)).toBe("12 MB")
  })

  it("filters images and wraps navigation", () => {
    const items = [
      { path: "/a.png", name: "a.png", sizeBytes: 1, kind: "image" as const },
      { path: "/a.txt", name: "a.txt", sizeBytes: 1, kind: "file" as const },
    ]
    expect(imageAttachments(items)).toEqual([items[0]])
    expect(wrappedIndex(0, -1, 3)).toBe(2)
    expect(wrappedIndex(2, 1, 3)).toBe(0)
  })

  it("clamps lightbox zoom", () => {
    expect(clampZoom(0.1)).toBe(0.5)
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(8)).toBe(4)
  })
})
