export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "")
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
