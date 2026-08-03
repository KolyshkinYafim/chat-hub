import type { PermissionMode } from "./permission"
import type { HookRun } from "./hooks"

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
  /** Provider instance (shadow home). Defaults to the provider id. */
  instanceId?: string
  /** Model id for this session (provider-specific). */
  model?: string
  /**
   * Permission mode for this session only. Absent = follow the global default,
   * so an existing session keeps behaving exactly as it did before it was ever
   * touched, and changing one session's mode never retunes the others.
   */
  permissionMode?: PermissionMode
  /** Active mode preset id (for the composer chip); undefined = no mode. */
  modeId?: string
  /** Resolved system prompt appended every turn — set when a mode is applied. */
  systemPrompt?: string
  /** The CLI's own session id, persisted so multi-turn resume survives restart. */
  agentSessionId?: string
  cwd: string
  status: SessionStatus
  /**
   * Who owns this session's card on the island: "hub" for one we spawned,
   * "terminal" for one a Claude Code hook reported. The island labels the host
   * from this; leaving it out made it guess from an empty focusApp.
   */
  source?: "hub" | "terminal"
  createdAt: number
  updatedAt: number
}

/** A first-class project the user pins in the sidebar, independent of sessions. */
export type Project = {
  id: string
  name: string
  cwd: string
  createdAt: number
}

export type ChatRole = "user" | "assistant" | "system"

/**
 * What a CLI's result line said this turn cost. Every field is optional and only
 * ever set from a number the CLI actually printed — a missing field means "this
 * agent does not report it", which the UI renders as nothing rather than as 0.
 */
export type TurnUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  costUsd?: number
  durationMs?: number
}

/** Running total over every turn of a session that reported usage. */
export type SessionUsage = TurnUsage & { turns: number }

export type ChatMessage = {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  createdAt: number
  streaming?: boolean
  /** Set on the assistant message once its turn's result line lands. */
  usage?: TurnUsage
  /**
   * Repo-relative-or-absolute paths this message's write/edit/multiedit tool
   * calls actually touched, in first-touched order. Absent/empty on messages
   * that never edited a file (including every user/system message).
   */
  touchedFiles?: string[]
}

/**
 * A follow-up the user wrote while a turn was still running. It is already in
 * the transcript but has not reached the CLI yet, so it stays cancellable.
 */
export type QueuedMessage = {
  id: string
  sessionId: string
  text: string
  createdAt: number
}

export type PermissionDecision = "allow" | "deny"

/** Which surface answered — the Hub transcript, the island, or nobody. */
export type PermissionDecider = "hub" | "island" | "expired" | "gone"

/**
 * A tool permission a Hub-spawned CLI is blocked on. The Hub and the island both
 * render it and either may answer; see docs/permissions.md.
 */
export type PermissionRequestInfo = {
  requestId: string
  /** Hub session it belongs to; null when the agent id matched nothing. */
  sessionId: string | null
  /** The agent's own namespaced id from the hook (e.g. "claude-<uuid>"). */
  agentSessionId: string
  /** Agent that asked, as the hook labels it ("claude", "codex", …). */
  source: string
  summary: string
  toolName?: string
  cwd?: string
  createdAt: number
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
  | {
      type: "chat.touchedFiles"
      sessionId: string
      messageId: string
      /** Full accumulated set for this message so far, not just the delta. */
      files: string[]
    }
  | { type: "sessions.replaced"; sessions: SessionMeta[] }
  | {
      type: "messages.replaced"
      sessionId: string
      messages: ChatMessage[]
    }
  | { type: "session.active"; sessionId: string | null }
  | {
      type: "queue.changed"
      sessionId: string
      queued: QueuedMessage[]
    }
  | {
      type: "usage.changed"
      sessionId: string
      /** The assistant message the turn produced, when there was one. */
      messageId?: string
      turn?: TurnUsage
      total: SessionUsage
    }
  | { type: "permission.request"; request: PermissionRequestInfo }
  | {
      type: "permission.resolved"
      requestId: string
      sessionId: string | null
      /** "cancelled" = the asking CLI went away before anyone decided. */
      outcome: PermissionDecision | "cancelled"
      decidedBy: PermissionDecider
    }
  /** One project-local hook finished (shell or prompt). See `src/main/hooks.ts`. */
  | { type: "hook.ran"; run: HookRun }

export type CreateSessionInput = {
  provider: ProviderId
  instanceId?: string
  title?: string
  cwd?: string
  project?: string
  model?: string
}

export type SessionSnapshot = {
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  /** Undelivered follow-ups per session — the queue survives a renderer reload. */
  queued: Record<string, QueuedMessage[]>
  /** Per-session totals; a session with no reporting CLI is simply absent. */
  usage: Record<string, SessionUsage>
  /** Tool permissions still blocking a CLI, for a renderer that just reloaded. */
  permissions: PermissionRequestInfo[]
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

/**
 * One path as `git status --porcelain` sees it. `index`/`work` are the raw two
 * status columns, so a file edited twice (staged then edited again) shows up in
 * both lists of the panel exactly as git reports it — no invented single state.
 */
export type GitFileChange = {
  /** Repo-relative, always the current name (a rename carries `from`). */
  path: string
  from?: string
  /** Staged column: "M", "A", "D", "R", … or " " for nothing staged. */
  index: string
  /** Worktree column: "M", "D", "?" (untracked), … or " ". */
  work: string
}

export type GitWorkingCopy = {
  root: string | null
  branch: string
  /** Commits ahead/behind the tracked upstream; 0/0 when there is none. */
  ahead: number
  behind: number
  files: GitFileChange[]
}

export type GitBranchList = {
  current: string
  branches: string[]
}
