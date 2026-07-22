import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { homedir } from "node:os"

const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".grok", "bin"),
  join(homedir(), ".nvm", "versions", "node"),
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a CLI binary from PATH + common install locations. */
export function findBinary(names: string[]): string | null {
  const pathEnv = process.env.PATH ?? ""
  const dirs = [
    ...pathEnv.split(delimiter).filter(Boolean),
    ...EXTRA_DIRS,
  ]

  // Expand nvm node bins one level
  const expanded: string[] = []
  for (const dir of dirs) {
    expanded.push(dir)
    if (dir.includes(`${join("nvm", "versions", "node")}`) && !dir.endsWith("bin")) {
      // skip bulk scan — specific nvm bin already in PATH usually
    }
  }

  for (const name of names) {
    if (name.includes("/")) {
      if (isExecutable(name)) return name
      continue
    }
    for (const dir of expanded) {
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
