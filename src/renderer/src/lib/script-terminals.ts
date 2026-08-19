import { surfaceBridge } from "./surface-bridge"

type ScriptTerminal = {
  ptyId: string
  chunks: string[]
  size: number
  off: () => void
}

const BACKLOG_LIMIT_CHARS = 200_000

const live = new Map<string, ScriptTerminal>()

/**
 * A pty that ran a script survives its surface unmounting (the dock shows one
 * surface at a time, and a dev server must outlive the switch to the browser
 * preview). This registry buffers output while the terminal surface is away so
 * a remount can replay it; plain shells keep dying with their surface.
 */
export function registerScriptTerminal(sessionId: string, ptyId: string): void {
  const existing = live.get(sessionId)
  if (existing?.ptyId === ptyId) return
  if (existing) remove(sessionId, true)
  const bridge = surfaceBridge()
  const record: ScriptTerminal = { ptyId, chunks: [], size: 0, off: () => {} }
  const offData = bridge.onTerminalData((chunk) => {
    if (chunk.ptyId !== ptyId) return
    record.chunks.push(chunk.data)
    record.size += chunk.data.length
    while (record.chunks.length > 1 && record.size > BACKLOG_LIMIT_CHARS) {
      const dropped = record.chunks.shift()
      if (dropped !== undefined) record.size -= dropped.length
    }
  })
  const offExit = bridge.onTerminalExit((exit) => {
    if (exit.ptyId !== ptyId) return
    remove(sessionId, false)
  })
  record.off = () => {
    offData()
    offExit()
  }
  live.set(sessionId, record)
}

export function scriptTerminalFor(
  sessionId: string,
): { ptyId: string; backlog: string } | null {
  const record = live.get(sessionId)
  if (!record) return null
  return { ptyId: record.ptyId, backlog: record.chunks.join("") }
}

export function isScriptTerminal(ptyId: string): boolean {
  for (const record of live.values()) {
    if (record.ptyId === ptyId) return true
  }
  return false
}

function remove(sessionId: string, kill: boolean): void {
  const record = live.get(sessionId)
  if (!record) return
  record.off()
  live.delete(sessionId)
  if (kill) surfaceBridge().termKill(record.ptyId)
}

export function pruneScriptTerminals(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...live.keys()]) {
    if (!liveSessionIds.has(sessionId)) remove(sessionId, true)
  }
}
