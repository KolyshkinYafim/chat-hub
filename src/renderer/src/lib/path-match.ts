export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "")
}

export function displayPath(cwd: string | undefined, path: string): string {
  const full = normalizePath(path)
  const base = cwd ? normalizePath(cwd) : ""
  if (base && full.startsWith(`${base}/`)) return full.slice(base.length + 1)
  return full
}

export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/")
  if (cut === -1) return { dir: "", name: path }
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

export function matchPath<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  wanted: string,
): T | null {
  const want = normalizePath(wanted)
  if (want === "") return null
  const exact = items.find((item) => normalizePath(pathOf(item)) === want)
  if (exact) return exact
  const suffix = items.find((item) =>
    want.endsWith(`/${normalizePath(pathOf(item))}`),
  )
  if (suffix) return suffix
  return (
    items.find((item) => normalizePath(pathOf(item)).endsWith(`/${want}`)) ??
    null
  )
}
