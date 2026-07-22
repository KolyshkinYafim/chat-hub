/** Derive sidebar project name from a working directory path. */
export function projectFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last || last === "Desktop" || last === "Home") return "Workspace"
  return last
}

export function normalizeProject(name: string | undefined, cwd: string): string {
  const trimmed = name?.trim()
  if (trimmed) return trimmed
  return projectFromCwd(cwd)
}
