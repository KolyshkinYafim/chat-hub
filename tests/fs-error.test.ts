import { describe, expect, it } from "vitest"

import { humanizeFsError } from "../src/renderer/src/lib/fs-error"

describe("humanizeFsError", () => {
  it("explains the unnamed errno macOS returns for an evicted iCloud file", () => {
    const said = humanizeFsError(
      "Unknown system error -11: Unknown system error -11, read",
    )
    expect(said).toMatch(/iCloud/)
    expect(said).not.toMatch(/-11/)
  })

  it("names the file when the message carries its path", () => {
    expect(
      humanizeFsError(
        "ENOENT: no such file or directory, open '/Users/dev/app/.chathub/board.json'",
      ),
    ).toBe("“board.json” is not there any more.")
  })

  it("falls back to a generic subject when there is no path to name", () => {
    expect(humanizeFsError("EACCES: permission denied")).toBe(
      "No permission to read this file.",
    )
  })

  it("covers the write-side failures a workspace can hit", () => {
    expect(humanizeFsError("ENOSPC: no space left on device, write")).toMatch(
      /disk is full/,
    )
    expect(
      humanizeFsError("EROFS: read-only file system, open '/mnt/ro/notes.md'"),
    ).toMatch(/read-only/)
    expect(humanizeFsError("EMFILE: too many open files")).toMatch(/Too many/)
  })

  it("distinguishes a folder from a broken path", () => {
    expect(
      humanizeFsError("EISDIR: illegal operation on a directory, read '/tmp/x'"),
    ).toMatch(/is a folder/)
    expect(
      humanizeFsError("ENOTDIR: not a directory, open '/tmp/file.txt/child'"),
    ).toMatch(/not a folder/)
  })

  it("leaves a message it does not recognise exactly as it was", () => {
    const raw = "Stop the running turn before reverting"
    expect(humanizeFsError(raw)).toBe(raw)
  })
})
