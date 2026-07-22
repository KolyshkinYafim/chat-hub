import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ChatMessage, SessionMeta } from "@shared/types"

export type PersistedState = {
  version: 1
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  activeSessionId: string | null
}

const EMPTY: PersistedState = {
  version: 1,
  sessions: [],
  messages: {},
  activeSessionId: null,
}

export class Persistence {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      const data = JSON.parse(raw) as PersistedState
      if (data?.version !== 1 || !Array.isArray(data.sessions)) {
        return { ...EMPTY }
      }
      return {
        version: 1,
        sessions: data.sessions,
        messages: data.messages ?? {},
        activeSessionId: data.activeSessionId ?? null,
      }
    } catch {
      return { ...EMPTY, messages: {} }
    }
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
    await rename(tmp, this.filePath)
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "state.json")
  }
}
