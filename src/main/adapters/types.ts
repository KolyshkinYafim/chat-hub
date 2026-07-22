import type {
  ChatMessage,
  ProviderId,
  SessionEvent,
  SessionMeta,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"

export type AdapterStartOpts = {
  sessionId: string
  cwd: string
  title?: string
}

export type EffortLevel = "low" | "medium" | "high" | "max"

export type AdapterSendOpts = {
  permissionMode?: PermissionMode
  model?: string
  effort?: EffortLevel
  /** Absolute file paths to attach (Claude --file, etc.) */
  attachments?: string[]
}

export type AdapterCallbacks = {
  onSessionEvent: (event: SessionEvent) => void
  onMessage: (message: ChatMessage) => void
  onDelta: (sessionId: string, messageId: string, delta: string) => void
  onStreamDone: (sessionId: string, messageId: string) => void
}

export interface AgentAdapter {
  readonly id: ProviderId
  readonly available: boolean
  start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void>
  send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
    opts?: AdapterSendOpts,
  ): Promise<void>
  abort(sessionId: string): Promise<void>
  dispose(sessionId: string): Promise<void>
}

export type CreateSessionResult = {
  session: SessionMeta
}
