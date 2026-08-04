import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises"
import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  FILE_WRITE_LIMIT_BYTES,
  STALE_WRITE_MESSAGE,
  type FileStamp,
} from "../src/shared/surfaces"
import { readFileText, saveFileText } from "../src/main/surfaces/files"

let root = ""
let outside = ""

async function stampOf(relPath: string): Promise<FileStamp> {
  return (await readFileText(root, relPath)).stamp
}

beforeEach(async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-save-")))
  root = join(base, "workspace")
  outside = join(base, "outside")
  await mkdir(root, { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(outside, { recursive: true })

  await writeFile(join(root, "src", "app.ts"), "export const app = 1\n", "utf8")
  await writeFile(join(root, "script.sh"), "#!/bin/sh\necho hi\n", {
    encoding: "utf8",
    mode: 0o755,
  })
  await writeFile(join(outside, "passwd"), "root:x:0:0\n", "utf8")
  await symlink(join(outside, "passwd"), join(root, "escape-file"))
  await symlink(outside, join(root, "escape-dir"))
  await symlink(join(root, "src"), join(root, "inside-link"))
})

describe("save containment", () => {
  it("writes a file that lives inside the workspace", async () => {
    const stamp = await stampOf("src/app.ts")
    const saved = await saveFileText(root, "src/app.ts", "export const app = 2\n", stamp)
    expect(saved.path).toBe("src/app.ts")
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe(
      "export const app = 2\n",
    )
    expect(saved.stamp.size).toBe(21)
  })

  it("refuses a ../ escape", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(
      saveFileText(root, "../outside/passwd", "owned\n", stamp),
    ).rejects.toThrow(/escapes the workspace/)
    await expect(
      saveFileText(root, "src/../../outside/passwd", "owned\n", stamp),
    ).rejects.toThrow(/escapes the workspace/)
    expect(await readFile(join(outside, "passwd"), "utf8")).toBe("root:x:0:0\n")
  })

  it("refuses an absolute path", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(
      saveFileText(root, join(outside, "passwd"), "owned\n", stamp),
    ).rejects.toThrow(/must be relative/)
    await expect(
      saveFileText(root, "/etc/hosts", "owned\n", stamp),
    ).rejects.toThrow(/must be relative/)
    expect(await readFile(join(outside, "passwd"), "utf8")).toBe("root:x:0:0\n")
  })

  it("refuses a symlink that leaves the workspace", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(
      saveFileText(root, "escape-file", "owned\n", stamp),
    ).rejects.toThrow(/escapes the workspace/)
    await expect(
      saveFileText(root, "escape-dir/passwd", "owned\n", stamp),
    ).rejects.toThrow(/escapes the workspace/)
    expect(await readFile(join(outside, "passwd"), "utf8")).toBe("root:x:0:0\n")
  })

  it("follows a symlink that stays inside and writes the real file", async () => {
    const stamp = await stampOf("inside-link/app.ts")
    const saved = await saveFileText(
      root,
      "inside-link/app.ts",
      "export const app = 3\n",
      stamp,
    )
    expect(saved.path).toBe("src/app.ts")
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe(
      "export const app = 3\n",
    )
  })

  it("refuses a NUL byte, a non-string path and a directory", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(saveFileText(root, "src\0/app.ts", "x", stamp)).rejects.toThrow(
      /Invalid path/,
    )
    await expect(saveFileText(root, 7, "x", stamp)).rejects.toThrow(
      /Invalid path/,
    )
    await expect(saveFileText(root, "src", "x", stamp)).rejects.toThrow(
      /Not a file/,
    )
  })

  it("refuses to create a file that does not exist yet", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(
      saveFileText(root, "src/brand-new.ts", "x", stamp),
    ).rejects.toThrow(/Not found/)
  })
})

describe("stale write refusal", () => {
  it("refuses when the mtime moved under the editor", async () => {
    const stamp = await stampOf("src/app.ts")
    const later = new Date(Date.now() + 5000)
    await utimes(join(root, "src", "app.ts"), later, later)

    await expect(
      saveFileText(root, "src/app.ts", "clobbered\n", stamp),
    ).rejects.toThrow(new RegExp(STALE_WRITE_MESSAGE))
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe(
      "export const app = 1\n",
    )
  })

  it("refuses when the size moved under the editor", async () => {
    const stamp = await stampOf("src/app.ts")
    await writeFile(join(root, "src", "app.ts"), "export const app = 11\n", "utf8")
    await utimes(
      join(root, "src", "app.ts"),
      new Date(stamp.mtimeMs),
      new Date(stamp.mtimeMs),
    )

    await expect(
      saveFileText(root, "src/app.ts", "clobbered\n", stamp),
    ).rejects.toThrow(new RegExp(STALE_WRITE_MESSAGE))
  })

  it("accepts the fresh stamp a successful save hands back", async () => {
    const first = await stampOf("src/app.ts")
    const saved = await saveFileText(root, "src/app.ts", "one\n", first)
    await expect(
      saveFileText(root, "src/app.ts", "two\n", saved.stamp),
    ).resolves.toMatchObject({ path: "src/app.ts" })
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("two\n")
  })

  it("refuses a payload with no stamp at all", async () => {
    await expect(
      saveFileText(root, "src/app.ts", "x", undefined),
    ).rejects.toThrow(/no read stamp/)
    await expect(
      saveFileText(root, "src/app.ts", "x", { mtimeMs: "soon", size: 1 }),
    ).rejects.toThrow(/no read stamp/)
  })
})

describe("save payload limits", () => {
  it("refuses anything that is not a string", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(saveFileText(root, "src/app.ts", 42, stamp)).rejects.toThrow(
      /not text/,
    )
  })

  it("refuses a payload over the write cap", async () => {
    const stamp = await stampOf("src/app.ts")
    await expect(
      saveFileText(root, "src/app.ts", "x".repeat(FILE_WRITE_LIMIT_BYTES + 1), stamp),
    ).rejects.toThrow(/save cap/)
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe(
      "export const app = 1\n",
    )
  })
})

describe("save side effects", () => {
  it("keeps the executable bit instead of publishing a fresh file", async () => {
    const before = statSync(join(root, "script.sh")).mode
    const stamp = await stampOf("script.sh")
    await saveFileText(root, "script.sh", "#!/bin/sh\necho bye\n", stamp)
    expect(statSync(join(root, "script.sh")).mode).toBe(before)
  })
})
