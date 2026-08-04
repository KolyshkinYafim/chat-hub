import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ChatMessage, SessionMeta, SessionUsage } from "@shared/types"
import { quarantineCorrupt, writeFileAtomic } from "./atomic-write"
import { dropLegacyMessageFieldsIn } from "./legacy-message"

export type PersistedState = {
  version: 1
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  /** Cost/token totals per session — absent for state written before wave 2. */
  usage?: Record<string, SessionUsage>
  activeSessionId: string | null
}

const EMPTY: PersistedState = {
  version: 1,
  sessions: [],
  messages: {},
  activeSessionId: null,
}

export class Persistence {
  constructor(readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      return { ...EMPTY, messages: {} }
    }
    try {
      const data = JSON.parse(raw) as PersistedState
      if (data?.version !== 1 || !Array.isArray(data.sessions)) {
        return { ...EMPTY }
      }
      return {
        version: 1,
        sessions: data.sessions,
        messages: stripLegacyFields(data.messages ?? {}),
        usage: data.usage ?? {},
        activeSessionId: data.activeSessionId ?? null,
      }
    } catch (err) {
      // Unreadable state is a lost transcript, not a fresh install: keep the file
      // as evidence instead of letting the first save of this run erase it.
      const parked = await quarantineCorrupt(this.filePath)
      console.error("[persistence] unreadable state parked at", parked, err)
      return { ...EMPTY, messages: {} }
    }
  }

  async save(state: PersistedState): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(state, null, 2))
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "state.json")
  }
}

function stripLegacyFields(
  messages: Record<string, ChatMessage[]>,
): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {}
  for (const [sessionId, list] of Object.entries(messages)) {
    out[sessionId] = Array.isArray(list) ? dropLegacyMessageFieldsIn(list) : []
  }
  return out
}
