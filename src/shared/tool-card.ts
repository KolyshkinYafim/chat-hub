export type ToolCardMeta = {
  id?: string
  desc?: string
  paths?: string[]
  added?: number
  removed?: number
  exitCode?: number
  error?: boolean
}

const MARK = "\u001f"

export function encodeToolCardMeta(meta: ToolCardMeta): string {
  const kept: Record<string, unknown> = {}
  if (meta.id) kept.id = meta.id
  if (meta.desc) kept.desc = meta.desc
  if (meta.paths && meta.paths.length > 0) kept.paths = meta.paths
  if (typeof meta.added === "number") kept.added = meta.added
  if (typeof meta.removed === "number") kept.removed = meta.removed
  if (typeof meta.exitCode === "number") kept.exitCode = meta.exitCode
  if (meta.error) kept.error = true
  if (Object.keys(kept).length === 0) return ""
  return `${MARK}${JSON.stringify(kept)}\n`
}

export function decodeToolCardMeta(raw: string): {
  meta: ToolCardMeta
  body: string
} {
  if (!raw.startsWith(MARK)) return { meta: {}, body: raw }
  const newline = raw.indexOf("\n")
  const head = newline === -1 ? raw.slice(1) : raw.slice(1, newline)
  const body = newline === -1 ? "" : raw.slice(newline + 1)
  if (head.startsWith("{")) {
    const parsed = parseObject(head)
    if (parsed) return { meta: readMeta(parsed), body }
  }
  return { meta: head ? { desc: head } : {}, body }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function readMeta(raw: Record<string, unknown>): ToolCardMeta {
  const meta: ToolCardMeta = {}
  if (typeof raw.id === "string") meta.id = raw.id
  if (typeof raw.desc === "string") meta.desc = raw.desc
  if (Array.isArray(raw.paths)) {
    const paths = raw.paths.filter((p): p is string => typeof p === "string")
    if (paths.length > 0) meta.paths = paths
  }
  if (typeof raw.added === "number") meta.added = raw.added
  if (typeof raw.removed === "number") meta.removed = raw.removed
  if (typeof raw.exitCode === "number") meta.exitCode = raw.exitCode
  if (raw.error === true) meta.error = true
  return meta
}

export function fenceFor(body: string): string {
  const runs = body.match(/`{3,}/g)
  const longest = runs
    ? runs.reduce((max, run) => Math.max(max, run.length), 2)
    : 2
  return "`".repeat(Math.max(3, longest + 1))
}
