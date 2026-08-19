/** Named per-project commands, persisted at `<cwd>/.chathub/scripts.json`. */

export type ProjectScript = {
  id: string
  name: string
  command: string
  /** Single digit 1–9; the renderer binds ⌘⌥<digit>. */
  hotkey?: string
  previewUrl?: string
  autoOpenPreview: boolean
  runOnWorktreeCreate: boolean
}

export type ScriptsFile = {
  scripts: ProjectScript[]
  updatedAt: number
}

export const SCRIPTS_REL_PATH = ".chathub/scripts.json"

export const MAX_PROJECT_SCRIPTS = 50

export function isValidScriptHotkey(value: string): boolean {
  return /^[1-9]$/.test(value)
}

/** A leading "-" would be read as shell/argv flags, never as a program. */
export function isValidScriptCommand(value: string): boolean {
  const command = value.trim()
  return command !== "" && !command.startsWith("-")
}

export function isValidPreviewUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function emptyScriptsFile(): ScriptsFile {
  return { scripts: [], updatedAt: 0 }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function freshScriptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function coerceScript(raw: unknown): Omit<ProjectScript, "hotkey"> & { hotkey?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const command = str(o.command)
  if (!isValidScriptCommand(command)) return null
  const name = str(o.name) || command
  const id = str(o.id) || freshScriptId()
  const hotkeyRaw = str(o.hotkey)
  const previewUrl = isValidPreviewUrl(str(o.previewUrl)) ? str(o.previewUrl) : undefined
  return {
    id,
    name,
    command,
    ...(isValidScriptHotkey(hotkeyRaw) ? { hotkey: hotkeyRaw } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    autoOpenPreview: o.autoOpenPreview === true && previewUrl !== undefined,
    runOnWorktreeCreate: o.runOnWorktreeCreate === true,
  }
}

/**
 * Coerce unknown JSON into a scripts file. The file is hand-editable, so a
 * garbage document reads as an empty list and a single bad entry is dropped
 * without blanking the rest. Duplicate ids keep the first entry; duplicate
 * hotkeys keep the first binding.
 */
export function parseScriptsFile(raw: unknown): ScriptsFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyScriptsFile()
  }
  const o = raw as Record<string, unknown>
  const list = Array.isArray(o.scripts) ? o.scripts : []
  const scripts: ProjectScript[] = []
  const seenIds = new Set<string>()
  const seenHotkeys = new Set<string>()
  for (const item of list) {
    if (scripts.length >= MAX_PROJECT_SCRIPTS) break
    const script = coerceScript(item)
    if (!script) continue
    if (seenIds.has(script.id)) continue
    seenIds.add(script.id)
    if (script.hotkey !== undefined) {
      if (seenHotkeys.has(script.hotkey)) delete script.hotkey
      else seenHotkeys.add(script.hotkey)
    }
    scripts.push(script)
  }
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) && o.updatedAt > 0
      ? o.updatedAt
      : 0
  return { scripts, updatedAt }
}
