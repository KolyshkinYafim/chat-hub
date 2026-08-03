import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import {
  SurfacePathError,
  resolveContainedPath,
  resolveWorkspaceRoot,
} from "../src/main/surfaces/paths"

let root = ""
let outside = ""

beforeAll(async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-paths-")))
  root = join(base, "workspace")
  outside = join(base, "secrets")
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "app.ts"), "export const app = 1\n", "utf8")
  await writeFile(join(outside, "passwd"), "root:x:0:0\n", "utf8")
  await symlink(outside, join(root, "escape-dir"))
  await symlink(join(outside, "passwd"), join(root, "escape-file"))
  await symlink(join(root, "src"), join(root, "inside-link"))
})

describe("workspace root", () => {
  it("rejects a cwd that is not a string", () => {
    expect(() => resolveWorkspaceRoot(42)).toThrow(SurfacePathError)
    expect(() => resolveWorkspaceRoot(null)).toThrow(SurfacePathError)
    expect(() => resolveWorkspaceRoot("")).toThrow(SurfacePathError)
  })

  it("rejects a cwd with an embedded NUL", () => {
    expect(() => resolveWorkspaceRoot(`${root}\0/etc`)).toThrow(SurfacePathError)
  })

  it("rejects a cwd that is a file", () => {
    expect(() => resolveWorkspaceRoot(join(root, "src", "app.ts"))).toThrow(
      SurfacePathError,
    )
  })
})

describe("path containment", () => {
  it("accepts the root itself", () => {
    const contained = resolveContainedPath(root, "")
    expect(contained.relativePath).toBe("")
    expect(contained.absolutePath).toBe(realpathSync(root))
  })

  it("accepts a nested path and reports it POSIX-relative", () => {
    const contained = resolveContainedPath(root, "src/app.ts")
    expect(contained.relativePath).toBe("src/app.ts")
  })

  it("rejects a ../ escape", () => {
    expect(() => resolveContainedPath(root, "../secrets/passwd")).toThrow(
      /escapes the workspace/,
    )
    expect(() => resolveContainedPath(root, "src/../../secrets")).toThrow(
      /escapes the workspace/,
    )
    expect(() => resolveContainedPath(root, "../..")).toThrow(
      /escapes the workspace/,
    )
  })

  it("rejects an absolute path", () => {
    expect(() => resolveContainedPath(root, "/etc/passwd")).toThrow(
      /must be relative/,
    )
    expect(() => resolveContainedPath(root, join(outside, "passwd"))).toThrow(
      /must be relative/,
    )
  })

  it("rejects a symlink pointing out of the workspace", () => {
    expect(() => resolveContainedPath(root, "escape-dir")).toThrow(
      /escapes the workspace/,
    )
    expect(() => resolveContainedPath(root, "escape-file")).toThrow(
      /escapes the workspace/,
    )
    expect(() => resolveContainedPath(root, "escape-dir/passwd")).toThrow(
      /escapes the workspace/,
    )
  })

  it("accepts a symlink that stays inside the workspace", () => {
    const contained = resolveContainedPath(root, "inside-link/app.ts")
    expect(contained.relativePath).toBe("src/app.ts")
  })

  it("rejects a NUL byte and a non-string path", () => {
    expect(() => resolveContainedPath(root, "src\0/app.ts")).toThrow(
      SurfacePathError,
    )
    expect(() => resolveContainedPath(root, 7)).toThrow(SurfacePathError)
  })

  it("rejects a path that does not exist", () => {
    expect(() => resolveContainedPath(root, "src/nope.ts")).toThrow(/Not found/)
  })
})
