import type { BuildInfo, StorageStats } from "./settings-types"

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/** One unit, at most one decimal — a settings card, not a disk utility. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < KB) return `${Math.round(bytes)} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}

/** Thousands separators without Intl, so the same string comes out anywhere. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const whole = Math.max(0, Math.round(n)).toString()
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** "1 session" / "4 sessions". */
export function countLabel(
  n: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(n)} ${Math.round(n) === 1 ? singular : plural}`
}

/** ISO stamp → "2026-08-20 14:03 UTC"; unparseable input passes through. */
export function formatBuildDate(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

/** One-line identity for a card header: "0.1.0 · a1b2c3d". */
export function buildLabel(info: BuildInfo): string {
  return `${info.version} · ${info.commit}`
}

/** "4 sessions (1 archived)" — the parenthetical only when some are archived. */
export function sessionsLabel(stats: StorageStats): string {
  const base = countLabel(stats.sessionCount, "session")
  if (stats.archivedSessionCount <= 0) return base
  return `${base} (${formatCount(stats.archivedSessionCount)} archived)`
}

/** Sessions and messages on one line, for a summary that has room for both. */
export function storageLabel(stats: StorageStats): string {
  return `${sessionsLabel(stats)} · ${countLabel(stats.messageCount, "message")}`
}

/**
 * The block a support conversation actually needs, in the order someone reads
 * it out loud. Plain text on purpose: it has to survive a paste anywhere.
 */
export function supportSummary(input: {
  build: BuildInfo
  storage: StorageStats | null
  dataDir: string
}): string {
  const { build, storage, dataDir } = input
  const built = build.packaged ? "" : " · unpackaged dev run"
  const lines = [
    `Chat Hub ${build.version} (${build.commit})`,
    `Built: ${formatBuildDate(build.builtAt)}${built}`,
    `Runtime: Electron ${build.electron} · Chrome ${build.chrome}` +
      ` · Node ${build.node}`,
    `Platform: ${build.platform} ${build.arch}`,
    `Data folder: ${dataDir}`,
  ]
  if (storage) {
    lines.push(
      `Storage: ${formatBytes(storage.dataDirBytes)} across ${countLabel(
        storage.fileCount,
        "file",
      )}`,
      `Sessions: ${storageLabel(storage)}`,
    )
  }
  return lines.join("\n")
}
