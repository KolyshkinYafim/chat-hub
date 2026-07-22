import { randomUUID } from "node:crypto"
import type { AdapterCallbacks } from "./types"

/** Shared helpers for NDJSON CLI streams → transcript callbacks. */

export type StreamTurn = {
  messageId: string
  started: boolean
  text: string
}

export function beginAssistant(
  sessionId: string,
  cb: AdapterCallbacks,
): StreamTurn {
  const messageId = randomUUID()
  cb.onMessage({
    id: messageId,
    sessionId,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    streaming: true,
  })
  return { messageId, started: true, text: "" }
}

export function pushDelta(
  turn: StreamTurn,
  sessionId: string,
  delta: string,
  cb: AdapterCallbacks,
): void {
  if (!delta) return
  turn.text += delta
  cb.onDelta(sessionId, turn.messageId, delta)
}

export function finishTurn(
  turn: StreamTurn | null,
  sessionId: string,
  cb: AdapterCallbacks,
): string {
  if (!turn) return ""
  cb.onStreamDone(sessionId, turn.messageId)
  if (turn.text.trim()) {
    cb.onSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "assistant",
      preview: turn.text.replace(/\s+/g, " ").slice(0, 160),
    })
  }
  return turn.text
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
    if (b.type === "tool_use" && typeof b.name === "string") {
      const input = b.input ? JSON.stringify(b.input).slice(0, 200) : ""
      parts.push(`\n\n🔧 **${b.name}**${input ? `\n\`${input}\`` : ""}\n`)
    }
  }
  return parts.join("")
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown
    if (v && typeof v === "object") return v as Record<string, unknown>
    return null
  } catch {
    return null
  }
}
