export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_input"
  | "error"
  | "done"

export type ProviderId = "mock" | "grok" | "claude" | "codex" | "opencode"

export type ProviderInfo = {
  id: ProviderId
  label: string
  available: boolean
  description: string
}

export type SessionMeta = {
  id: string
  title: string
  /** Project / folder group in the sidebar (e.g. mary, FinanceApp). */
  project: string
  provider: ProviderId
  /** Model id for this session (provider-specific). */
  model?: string
  cwd: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

export type ChatRole = "user" | "assistant" | "system"

export type ChatMessage = {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  createdAt: number
  streaming?: boolean
}

export type SessionEvent =
  | { type: "session.upsert"; session: SessionMeta }
  | { type: "session.status"; id: string; status: SessionStatus }
  | {
      type: "session.permission"
      id: string
      requestId: string
      summary: string
    }
  | {
      type: "session.question"
      id: string
      requestId: string
      prompt: string
      options?: string[]
    }
  | {
      type: "session.message"
      id: string
      role: ChatRole
      preview: string
    }
  | {
      type: "session.ended"
      id: string
      reason: "done" | "error" | "killed"
    }

export type HubEvent =
  | SessionEvent
  | { type: "chat.message"; message: ChatMessage }
  | {
      type: "chat.delta"
      sessionId: string
      messageId: string
      delta: string
    }
  | { type: "chat.done"; sessionId: string; messageId: string }
  | { type: "sessions.replaced"; sessions: SessionMeta[] }
  | {
      type: "messages.replaced"
      sessionId: string
      messages: ChatMessage[]
    }
  | { type: "session.active"; sessionId: string | null }

export type CreateSessionInput = {
  provider: ProviderId
  title?: string
  cwd?: string
  project?: string
  model?: string
}

export type SessionSnapshot = {
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  activeSessionId: string | null
}

/** Static fallback; main process returns live availability via listProviders. */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "grok",
    label: "Grok Build",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "opencode",
    label: "OpenCode",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "codex",
    label: "Codex CLI",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "mock",
    label: "Mock",
    available: true,
    description: "UI testing only",
  },
]

export type GitCheckoutInfo = {
  branch: string
  dirty: boolean
  root: string | null
}
