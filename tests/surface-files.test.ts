import { copyFile, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import {
  FILE_READ_LIMIT_BYTES,
  INLINE_IMAGE_LIMIT_BYTES,
} from "../src/shared/surfaces"
import { listDir, openFile, readFileText } from "../src/main/surfaces/files"

const FIXTURES = join(__dirname, "..", "fixtures", "files-surface")

const mintMediaUrl = ({ mime }: { mime: string }) => `stub-media://${mime}`

let root = ""
let outside = ""

beforeAll(async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-files-")))
  root = join(base, "workspace")
  outside = join(base, "outside")
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })

  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "node_modules"), { recursive: true })
  await mkdir(join(root, ".git"), { recursive: true })
  await mkdir(join(root, "Assets"), { recursive: true })
  await writeFile(join(root, ".DS_Store"), "junk", "utf8")
  await writeFile(join(root, ".env"), "SECRET=1\n", "utf8")
  await writeFile(join(root, "README.md"), "# hi\n", "utf8")
  await writeFile(join(root, "banana.txt"), "yellow", "utf8")
  await writeFile(join(root, "Apple.txt"), "red", "utf8")
  await writeFile(join(root, "src", "app.ts"), "export const app = 1\n", "utf8")

  await writeFile(join(outside, "passwd"), "root:x:0:0\n", "utf8")
  await symlink(join(outside, "passwd"), join(root, "escape-file"))
  await symlink(join(root, "README.md"), join(root, "readme-link"))

  await writeFile(
    join(root, "binary.bin"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
  )
  await writeFile(
    join(root, "late-nul.bin"),
    Buffer.concat([
      Buffer.alloc(9 * 1024, 0x61),
      Buffer.from([0x00]),
      Buffer.alloc(16, 0x61),
    ]),
  )
  await writeFile(
    join(root, "huge.txt"),
    "x".repeat(FILE_READ_LIMIT_BYTES + 4096),
    "utf8",
  )
  await writeFile(
    join(root, "exact.txt"),
    "y".repeat(FILE_READ_LIMIT_BYTES),
    "utf8",
  )

  for (const name of [
    "logo.png",
    "badge.svg",
    "clip.mp4",
    "tone.m4a",
    "payload.bin",
    "notes.md",
  ]) {
    await copyFile(join(FIXTURES, name), join(root, name))
  }
  await copyFile(join(FIXTURES, "logo.png"), join(root, "mislabelled.txt"))
})

describe("directory listing", () => {
  it("skips .git, node_modules and .DS_Store but keeps other hidden files", async () => {
    const listing = await listDir(root, "")
    const names = listing.entries.map((e) => e.name)
    expect(names).not.toContain(".git")
    expect(names).not.toContain("node_modules")
    expect(names).not.toContain(".DS_Store")
    expect(names).toContain(".env")
  })

  it("sorts directories first, then case-insensitively by name", async () => {
    const listing = await listDir(root, "")
    const kinds = listing.entries.map((e) => e.kind)
    expect(kinds.indexOf("file")).toBeGreaterThan(kinds.lastIndexOf("dir"))

    const dirNames = listing.entries
      .filter((e) => e.kind === "dir")
      .map((e) => e.name)
    expect(dirNames).toEqual(["Assets", "src"])

    const fileNames = listing.entries
      .filter((e) => e.kind === "file")
      .map((e) => e.name)
    expect(fileNames.indexOf("Apple.txt")).toBeLessThan(
      fileNames.indexOf("banana.txt"),
    )
    expect(fileNames.indexOf("banana.txt")).toBeLessThan(
      fileNames.indexOf("README.md"),
    )
  })

  it("drops symlinks that leave the workspace and keeps ones that stay", async () => {
    const names = (await listDir(root, "")).entries.map((e) => e.name)
    expect(names).not.toContain("escape-file")
    expect(names).toContain("readme-link")
  })

  it("reports paths relative to the workspace with POSIX separators", async () => {
    const listing = await listDir(root, "src")
    expect(listing.path).toBe("src")
    expect(listing.entries).toEqual([
      { name: "app.ts", path: "src/app.ts", kind: "file", size: 21 },
    ])
  })

  it("refuses to list outside the workspace", async () => {
    await expect(listDir(root, "../outside")).rejects.toThrow(
      /escapes the workspace/,
    )
    await expect(listDir(root, outside)).rejects.toThrow(/must be relative/)
  })

  it("refuses to list a file", async () => {
    await expect(listDir(root, "README.md")).rejects.toThrow(/Not a directory/)
  })
})

describe("file reading", () => {
  it("returns text untruncated for a small file", async () => {
    const contents = await readFileText(root, "src/app.ts")
    expect(contents).toMatchObject({
      path: "src/app.ts",
      text: "export const app = 1\n",
      truncated: false,
      binary: false,
    })
  })

  it("stamps the read with the mtime and size it saw", async () => {
    const contents = await readFileText(root, "src/app.ts")
    const stats = statSync(join(root, "src", "app.ts"))
    expect(contents.stamp.size).toBe(stats.size)
    expect(contents.stamp.mtimeMs).toBe(Math.round(stats.mtimeMs))
  })

  it("caps at the read limit and says so", async () => {
    const contents = await readFileText(root, "huge.txt")
    expect(contents.truncated).toBe(true)
    expect(contents.binary).toBe(false)
    expect(contents.text).toHaveLength(FILE_READ_LIMIT_BYTES)
  })

  it("does not call a file exactly at the limit truncated", async () => {
    const contents = await readFileText(root, "exact.txt")
    expect(contents.truncated).toBe(false)
    expect(contents.text).toHaveLength(FILE_READ_LIMIT_BYTES)
  })

  it("refuses a binary file with empty text", async () => {
    const contents = await readFileText(root, "binary.bin")
    expect(contents.binary).toBe(true)
    expect(contents.text).toBe("")
    expect(contents.truncated).toBe(false)
  })

  it("ignores a NUL that lands past the sniff window", async () => {
    const contents = await readFileText(root, "late-nul.bin")
    expect(contents.binary).toBe(false)
  })

  it("refuses to read outside the workspace", async () => {
    await expect(readFileText(root, "../outside/passwd")).rejects.toThrow(
      /escapes the workspace/,
    )
    await expect(readFileText(root, "escape-file")).rejects.toThrow(
      /escapes the workspace/,
    )
    await expect(readFileText(root, "/etc/passwd")).rejects.toThrow(
      /must be relative/,
    )
  })

  it("refuses to read a directory", async () => {
    await expect(readFileText(root, "src")).rejects.toThrow(/Not a file/)
  })
})

describe("opening a file for the viewer", () => {
  it("hands a text file back as editable text", async () => {
    const opened = await openFile(root, "src/app.ts", mintMediaUrl)
    expect(opened.kind).toBe("text")
    expect(opened.text).toBe("export const app = 1\n")
    expect(opened.dataUrl).toBeNull()
    expect(opened.streamUrl).toBeNull()
  })

  it("inlines a PNG as a data URL and never as text", async () => {
    const opened = await openFile(root, "logo.png", mintMediaUrl)
    expect(opened.kind).toBe("image")
    expect(opened.mime).toBe("image/png")
    expect(opened.text).toBeNull()
    expect(opened.dataUrl?.startsWith("data:image/png;base64,")).toBe(true)
    expect(opened.size).toBeLessThan(INLINE_IMAGE_LIMIT_BYTES)
  })

  it("gives an SVG both a picture and its source", async () => {
    const opened = await openFile(root, "badge.svg", mintMediaUrl)
    expect(opened.kind).toBe("image")
    expect(opened.mime).toBe("image/svg+xml")
    expect(opened.text).toContain("<svg")
    expect(opened.dataUrl?.startsWith("data:image/svg+xml;base64,")).toBe(true)
  })

  it("points video and audio at a stream URL instead of inlining", async () => {
    const clip = await openFile(root, "clip.mp4", mintMediaUrl)
    expect(clip.kind).toBe("video")
    expect(clip.mime).toBe("video/mp4")
    expect(clip.dataUrl).toBeNull()
    expect(clip.streamUrl).toBe("stub-media://video/mp4")

    const tone = await openFile(root, "tone.m4a", mintMediaUrl)
    expect(tone.kind).toBe("audio")
    expect(tone.mime).toBe("audio/mp4")
    expect(tone.streamUrl).toBe("stub-media://audio/mp4")
  })

  it("refuses a binary file with no text and no preview", async () => {
    const opened = await openFile(root, "payload.bin", mintMediaUrl)
    expect(opened.kind).toBe("binary")
    expect(opened.text).toBeNull()
    expect(opened.dataUrl).toBeNull()
    expect(opened.streamUrl).toBeNull()
  })

  it("trusts magic bytes over a lying extension", async () => {
    const opened = await openFile(root, "mislabelled.txt", mintMediaUrl)
    expect(opened.kind).toBe("image")
    expect(opened.mime).toBe("image/png")
  })

  it("keeps markdown as text so the viewer can render and edit it", async () => {
    const opened = await openFile(root, "notes.md", mintMediaUrl)
    expect(opened.kind).toBe("text")
    expect(opened.text).toContain("```mermaid")
  })

  it("refuses to open outside the workspace", async () => {
    await expect(
      openFile(root, "../outside/passwd", mintMediaUrl),
    ).rejects.toThrow(/escapes the workspace/)
    await expect(openFile(root, "escape-file", mintMediaUrl)).rejects.toThrow(
      /escapes the workspace/,
    )
  })
})
