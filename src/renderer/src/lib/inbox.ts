import { activityStamp, needsAction } from "@shared/attention"
import type {
  AgentInputRequestInfo,
  PermissionRequestInfo,
  SessionMeta,
} from "@shared/types"

export type InboxKind = "permission" | "question" | "failed"

export type InboxCard = {
  id: string
  kind: InboxKind
  sessionId: string | null
  requestId: string | null
  title: string
  project: string
  at: number
  body: string
}

export type InboxCursor = { key: string | null; index: number }

const BODY_MAX = 96
const UNKNOWN_TITLE = "Unknown session"
const UNKNOWN_PROJECT = "—"

export function inboxOneLine(text: string, limit = BODY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1).trimEnd()}…`
}

export function inboxPrimaryAction(kind: InboxKind): "allow" | "open" {
  return kind === "permission" ? "allow" : "open"
}

export function resolveInboxCursor(
  keys: readonly string[],
  cursor: InboxCursor,
): number {
  if (keys.length === 0) return 0
  if (cursor.key !== null) {
    const found = keys.indexOf(cursor.key)
    if (found !== -1) return found
  }
  return Math.min(Math.max(cursor.index, 0), keys.length - 1)
}

export function buildInboxCards(
  sessions: readonly SessionMeta[],
  permissions: readonly PermissionRequestInfo[],
  inputRequests: readonly AgentInputRequestInfo[],
): InboxCard[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const cards: InboxCard[] = []

  for (const permission of permissions) {
    const session = permission.sessionId
      ? (byId.get(permission.sessionId) ?? null)
      : null
    const detail = [permission.toolName, permission.summary]
      .filter(Boolean)
      .join(" · ")
    cards.push({
      id: `permission:${permission.requestId}`,
      kind: "permission",
      sessionId: permission.sessionId,
      requestId: permission.requestId,
      title: session?.title ?? UNKNOWN_TITLE,
      project: session?.project ?? UNKNOWN_PROJECT,
      at: permission.createdAt,
      body: inboxOneLine(detail || "Approval needed"),
    })
  }

  for (const request of inputRequests) {
    const session = byId.get(request.sessionId) ?? null
    cards.push({
      id: `question:${request.requestId}`,
      kind: "question",
      sessionId: request.sessionId,
      requestId: request.requestId,
      title: session?.title ?? UNKNOWN_TITLE,
      project: session?.project ?? UNKNOWN_PROJECT,
      at: request.createdAt,
      body: questionBody(request),
    })
  }

  for (const session of sessions) {
    if (session.status !== "error") continue
    if (!needsAction(session)) continue
    cards.push({
      id: `failed:${session.id}`,
      kind: "failed",
      sessionId: session.id,
      requestId: null,
      title: session.title,
      project: session.project,
      at: activityStamp(session),
      body: "The agent stopped with an error",
    })
  }

  cards.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  return cards
}

function questionBody(request: AgentInputRequestInfo): string {
  const first = request.questions[0]
  const prompt =
    first?.prompt.trim() ||
    first?.header.trim() ||
    "The agent needs an answer to continue."
  const prefix =
    request.questions.length > 1
      ? `${request.questions.length} questions · `
      : ""
  return inboxOneLine(`${prefix}${prompt}`)
}
