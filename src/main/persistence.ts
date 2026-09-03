import { access, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ChatMessage, SessionMeta, SessionUsage } from "@shared/types"
import { quarantineCorrupt, writeFileAtomic } from "./atomic-write"
import { dropLegacyMessageFieldsIn } from "./legacy-message"
import { sessionDirUnder } from "./message-archive"

export type PersistedIndex = {
  version: 1
  sessions: SessionMeta[]
  usage?: Record<string, SessionUsage>
  activeSessionId: string | null
}

type LegacyState = {
  version: 1
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  usage?: Record<string, SessionUsage>
  activeSessionId: string | null
}

function emptyIndex(): PersistedIndex {
  return { version: 1, sessions: [], usage: {}, activeSessionId: null }
}

export class Persistence {
  readonly indexPath: string
  readonly sessionsDir: string

  constructor(readonly filePath: string) {
    const dataDir = dirname(filePath)
    this.indexPath = join(dataDir, "index.json")
    this.sessionsDir = join(dataDir, "sessions")
  }

  hotPathFor(sessionId: string): string {
    return join(sessionDirUnder(this.sessionsDir, sessionId), "hot.json")
  }

  async loadIndex(): Promise<PersistedIndex> {
    await this.migrateLegacyState()
    let raw: string
    try {
      raw = await readFile(this.indexPath, "utf8")
    } catch {
      return emptyIndex()
    }
    try {
      const data = JSON.parse(raw) as PersistedIndex
      if (data?.version !== 1 || !Array.isArray(data.sessions)) {
        return emptyIndex()
      }
      return {
        version: 1,
        sessions: data.sessions,
        usage: data.usage ?? {},
        activeSessionId: data.activeSessionId ?? null,
      }
    } catch (err) {
      const parked = await quarantineCorrupt(this.indexPath)
      console.error("[persistence] unreadable index parked at", parked, err)
      return emptyIndex()
    }
  }

  async saveIndex(index: PersistedIndex): Promise<void> {
    await writeFileAtomic(this.indexPath, JSON.stringify(index, null, 2))
  }

  async loadHotMessages(sessionId: string): Promise<ChatMessage[]> {
    const path = this.hotPathFor(sessionId)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch {
      return []
    }
    try {
      const data = JSON.parse(raw) as unknown
      if (!Array.isArray(data)) {
        throw new Error("hot store is not a message list")
      }
      return dropLegacyMessageFieldsIn(data as ChatMessage[])
    } catch (err) {
      const parked = await quarantineCorrupt(path)
      console.error(
        "[persistence] unreadable hot messages for",
        sessionId,
        "parked at",
        parked,
        err,
      )
      return []
    }
  }

  async saveHotMessages(
    sessionId: string,
    messages: ChatMessage[],
  ): Promise<void> {
    await writeFileAtomic(this.hotPathFor(sessionId), JSON.stringify(messages))
  }

  private async migrateLegacyState(): Promise<void> {
    if (await fileExists(this.indexPath)) return
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      return
    }
    let legacy: LegacyState
    try {
      const data = JSON.parse(raw) as LegacyState
      if (data?.version !== 1 || !Array.isArray(data.sessions)) {
        await rename(this.filePath, this.legacyBackupPath())
        return
      }
      legacy = data
    } catch (err) {
      const parked = await quarantineCorrupt(this.filePath)
      console.error("[persistence] unreadable state parked at", parked, err)
      return
    }
    for (const session of legacy.sessions) {
      const messages = legacy.messages?.[session.id]
      if (!Array.isArray(messages) || messages.length === 0) continue
      await this.saveHotMessages(session.id, dropLegacyMessageFieldsIn(messages))
    }
    await this.saveIndex({
      version: 1,
      sessions: legacy.sessions,
      usage: legacy.usage ?? {},
      activeSessionId: legacy.activeSessionId ?? null,
    })
    await rename(this.filePath, this.legacyBackupPath())
  }

  private legacyBackupPath(): string {
    return `${this.filePath}.legacy-${Date.now()}`
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "state.json")
  }

  static defaultIndexPath(userData: string): string {
    return join(userData, "data", "index.json")
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
