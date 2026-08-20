import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildLabel,
  countLabel,
  formatBuildDate,
  formatBytes,
  formatCount,
  sessionsLabel,
  storageLabel,
  supportSummary,
} from "@shared/support"
import type { BuildInfo, StorageStats } from "@shared/settings-types"
import { parseBuildStamp, readBuildInfo } from "../src/main/build-info"
import { dirStats } from "../src/main/storage-stats"

const build: BuildInfo = {
  version: "0.1.0",
  commit: "a1b2c3d",
  builtAt: "2026-08-19T09:41:00Z",
  packaged: true,
  electron: "35.2.1",
  chrome: "134.0.0",
  node: "22.14.0",
  platform: "darwin",
  arch: "arm64",
}

const storage: StorageStats = {
  dataDirBytes: 48 * 1024 * 1024,
  fileCount: 187,
  sessionCount: 4,
  archivedSessionCount: 1,
  messageCount: 1362,
}

describe("formatBytes", () => {
  it("steps through the units", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB")
  })

  it("never renders a negative or non-finite size", () => {
    expect(formatBytes(-1)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
  })
})

describe("formatCount", () => {
  it("groups thousands the same way in every locale", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(999)).toBe("999")
    expect(formatCount(1362)).toBe("1,362")
    expect(formatCount(1234567)).toBe("1,234,567")
  })
})

describe("countLabel", () => {
  it("agrees with its noun", () => {
    expect(countLabel(1, "session")).toBe("1 session")
    expect(countLabel(0, "session")).toBe("0 sessions")
    expect(countLabel(2000, "file")).toBe("2,000 files")
  })

  it("takes an irregular plural", () => {
    expect(countLabel(2, "entry", "entries")).toBe("2 entries")
  })
})

describe("formatBuildDate", () => {
  it("renders a stable UTC stamp", () => {
    expect(formatBuildDate("2026-08-19T09:41:00Z")).toBe("2026-08-19 09:41 UTC")
  })

  it("says nothing rather than something wrong", () => {
    expect(formatBuildDate(null)).toBe("—")
    expect(formatBuildDate("not a date")).toBe("not a date")
  })
})

describe("buildLabel / storageLabel", () => {
  it("puts version and commit on one line", () => {
    expect(buildLabel(build)).toBe("0.1.0 · a1b2c3d")
  })

  it("mentions archived sessions only when there are some", () => {
    expect(sessionsLabel(storage)).toBe("4 sessions (1 archived)")
    expect(sessionsLabel({ ...storage, archivedSessionCount: 0 })).toBe(
      "4 sessions",
    )
  })

  it("puts sessions and messages on one summary line", () => {
    expect(storageLabel(storage)).toBe("4 sessions (1 archived) · 1,362 messages")
  })
})

describe("supportSummary", () => {
  it("leads with the version and commit", () => {
    const text = supportSummary({ build, storage, dataDir: "/data" })
    expect(text.split("\n")[0]).toBe("Chat Hub 0.1.0 (a1b2c3d)")
    expect(text).toContain("Data folder: /data")
    expect(text).toContain("Storage: 48.0 MB across 187 files")
  })

  it("flags an unpackaged run so nobody chases a phantom build", () => {
    const text = supportSummary({
      build: { ...build, packaged: false, builtAt: null, commit: "dev" },
      storage: null,
      dataDir: "/data",
    })
    expect(text).toContain("unpackaged dev run")
    expect(text).not.toContain("Storage:")
  })
})

describe("parseBuildStamp", () => {
  it("reads what packaging/build-app.sh writes", () => {
    expect(
      parseBuildStamp(
        '{"version":"0.1.0","commit":"a1b2c3d-dirty","builtAt":"2026-08-19T09:41:00Z"}',
      ),
    ).toEqual({
      version: "0.1.0",
      commit: "a1b2c3d-dirty",
      builtAt: "2026-08-19T09:41:00Z",
    })
  })

  it("rejects a truncated or hand-edited file", () => {
    expect(parseBuildStamp("{")).toBeNull()
    expect(parseBuildStamp("null")).toBeNull()
    expect(parseBuildStamp('{"commit":"a1b2c3d"}')).toBeNull()
  })
})

describe("readBuildInfo", () => {
  const versions = {
    electron: "35.2.1",
    chrome: "134.0.0",
    node: "22.14.0",
  } as NodeJS.ProcessVersions

  it("uses the stamp a packaged bundle carries", () => {
    const info = readBuildInfo({
      appPath: "/app",
      packaged: true,
      version: "0.0.0",
      versions,
      platform: "darwin",
      arch: "arm64",
      readStamp: (path) => {
        expect(path).toBe("/app/out/build-info.json")
        return '{"version":"0.1.0","commit":"a1b2c3d","builtAt":"2026-08-19T09:41:00Z"}'
      },
    })
    expect(info.version).toBe("0.1.0")
    expect(info.commit).toBe("a1b2c3d")
    expect(info.builtAt).toBe("2026-08-19T09:41:00Z")
  })

  it("never claims a stamped commit for an unpackaged run", () => {
    const info = readBuildInfo({
      appPath: "/repo",
      packaged: false,
      version: "0.1.0",
      versions,
      platform: "darwin",
      arch: "arm64",
      readStamp: () => {
        throw new Error("dev must not read the stamp")
      },
    })
    expect(info.commit).toBe("dev")
    expect(info.builtAt).toBeNull()
    expect(info.packaged).toBe(false)
  })

  it("survives a bundle that shipped without a stamp", () => {
    const info = readBuildInfo({
      appPath: "/app",
      packaged: true,
      version: "0.1.0",
      versions,
      platform: "darwin",
      arch: "arm64",
      readStamp: () => {
        throw new Error("ENOENT")
      },
    })
    expect(info.commit).toBe("unstamped")
    expect(info.version).toBe("0.1.0")
  })
})

describe("dirStats", () => {
  it("sums a tree without following symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-hub-stats-"))
    writeFileSync(join(root, "state.json"), "x".repeat(100))
    mkdirSync(join(root, "sessions"))
    writeFileSync(join(root, "sessions", "a.jsonl"), "y".repeat(50))
    symlinkSync(root, join(root, "loop"))

    expect(await dirStats(root)).toEqual({ bytes: 150, files: 3 })
  })

  it("reads a missing folder as empty rather than throwing", async () => {
    expect(await dirStats(join(tmpdir(), "chat-hub-absent-xyz"))).toEqual({
      bytes: 0,
      files: 0,
    })
  })
})
