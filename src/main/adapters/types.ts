import type {
  ChatMessage,
  ProviderId,
  SessionEvent,
  SessionMeta,
} from "@shared/types"

export type AdapterStartOpts = {
  sessionId: string
  cwd: string
  title?: string
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
  ): Promise<void>
  abort(sessionId: string): Promise<void>
  dispose(sessionId: string): Promise<void>
}

export type CreateSessionResult = {
  session: SessionMeta
}
