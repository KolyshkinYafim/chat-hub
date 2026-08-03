import { accessSync, constants, readdirSync } from "node:fs"
import { delimiter, join } from "node:path"
import { homedir } from "node:os"

const NVM_ROOT = join(homedir(), ".nvm", "versions", "node")

const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".grok", "bin"),
]

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * ~/.nvm/versions/node holds version folders, never binaries — a CLI installed
 * only through nvm lives one level deeper, and the GUI PATH has no nvm shim.
 */
function nvmBinDirs(): string[] {
  try {
    return readdirSync(NVM_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(NVM_ROOT, e.name, "bin"))
  } catch {
    return []
  }
}

/** Resolve a CLI binary from PATH + common install locations. */
export function findBinary(names: string[]): string | null {
  const pathEnv = process.env.PATH ?? ""
  const dirs = [
    ...pathEnv.split(delimiter).filter(Boolean),
    ...EXTRA_DIRS,
    ...nvmBinDirs(),
  ]

  for (const name of names) {
    if (name.includes("/")) {
      if (isExecutable(name)) return name
      continue
    }
    for (const dir of dirs) {
      const full = join(dir, name)
      if (isExecutable(full)) return full
    }
  }
  return null
}

export type DetectedBinary = {
  path: string
  version?: string
}
