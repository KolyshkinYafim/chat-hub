import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BuildInfo } from "@shared/settings-types"

/** The three fields packaging/build-app.sh writes into out/build-info.json. */
export type BuildStamp = {
  version: string
  commit: string
  builtAt: string
}

/** Parses the stamp; a truncated or hand-edited file reads as "no stamp". */
export function parseBuildStamp(raw: string): BuildStamp | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== "object") return null
  const { version, commit, builtAt } = data as Record<string, unknown>
  if (typeof version !== "string" || !version) return null
  if (typeof commit !== "string" || !commit) return null
  return {
    version,
    commit,
    builtAt: typeof builtAt === "string" ? builtAt : "",
  }
}

export type BuildInfoInput = {
  /** app.getAppPath() — the asar root in a packaged app, the repo in dev. */
  appPath: string
  packaged: boolean
  /** package.json version, the fallback when no stamp shipped. */
  version: string
  versions: NodeJS.ProcessVersions
  platform: string
  arch: string
  readStamp?: (path: string) => string
}

/**
 * A dev run deliberately reports "dev" even when out/build-info.json exists:
 * that file describes the last *packaged* build, and claiming its commit for
 * code being served by Vite is exactly the lie a support thread cannot afford.
 */
export function readBuildInfo(input: BuildInfoInput): BuildInfo {
  const read = input.readStamp ?? ((p: string) => readFileSync(p, "utf8"))
  let stamp: BuildStamp | null = null
  if (input.packaged) {
    try {
      stamp = parseBuildStamp(read(join(input.appPath, "out", "build-info.json")))
    } catch {
      /* unstamped bundle — fall back to package.json below */
    }
  }
  return {
    version: stamp?.version ?? input.version,
    commit: stamp?.commit ?? (input.packaged ? "unstamped" : "dev"),
    builtAt: stamp?.builtAt ? stamp.builtAt : null,
    packaged: input.packaged,
    electron: input.versions.electron ?? "—",
    chrome: input.versions.chrome ?? "—",
    node: input.versions.node ?? "—",
    platform: input.platform,
    arch: input.arch,
  }
}
