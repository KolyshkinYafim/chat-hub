import type { TurnUsage } from "@shared/types"
import {
  beginAssistant,
  finishTurn,
  pushDelta,
  safeJson,
  type StreamTurn,
} from "./stream-parse"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
  ConversationTurn,
} from "./types"

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

export function normalizeOllamaBaseUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? ""
  if (!trimmed) return DEFAULT_OLLAMA_BASE_URL
  return trimmed.replace(/\/+$/, "")
}

export type OllamaChatPayload = {
  model: string
  messages: ConversationTurn[]
  stream: true
}

export function buildOllamaChatPayload(input: {
  model: string
  message: string
  history?: ConversationTurn[]
  systemPrompt?: string
}): OllamaChatPayload {
  const messages: ConversationTurn[] = []
  const system = input.systemPrompt?.trim()
  if (system) messages.push({ role: "system", content: system })
  for (const turn of input.history ?? []) {
    if (!turn.content.trim()) continue
    messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: "user", content: input.message })
  return { model: input.model, messages, stream: true }
}

export type OllamaChatEvent = {
  delta: string
  done: boolean
  error?: string
  usage?: TurnUsage
}

export function parseOllamaChatLine(line: string): OllamaChatEvent | null {
  const event = safeJson(line)
  if (!event) return null
  if (typeof event.error === "string" && event.error) {
    return { delta: "", done: true, error: event.error }
  }
  const message = event.message
  const content =
    message && typeof message === "object"
      ? (message as { content?: unknown }).content
      : undefined
  const delta = typeof content === "string" ? content : ""
  const done = event.done === true
  return { delta, done, usage: done ? usageFromDoneLine(event) : undefined }
}

function usageFromDoneLine(event: Record<string, unknown>): TurnUsage | undefined {
  const usage: TurnUsage = {}
  if (typeof event.prompt_eval_count === "number") {
    usage.inputTokens = event.prompt_eval_count
  }
  if (typeof event.eval_count === "number") {
    usage.outputTokens = event.eval_count
  }
  if (typeof event.total_duration === "number") {
    usage.durationMs = Math.round(event.total_duration / 1_000_000)
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

export async function* ndjsonLines(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of chunks) {
    buffered +=
      typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let newline = buffered.indexOf("\n")
    while (newline !== -1) {
      yield buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
    }
  }
  buffered += decoder.decode()
  if (buffered.trim()) yield buffered
}

export function renderOllamaFailure(baseUrl: string, err: unknown): string {
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? ` (${err.cause.message})`
      : ""
  const detail = `${err instanceof Error ? err.message : String(err)}${cause}`
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|socket/i.test(detail)) {
    return (
      `**Ollama is not reachable at ${baseUrl}.** ` +
      "Start it with `ollama serve`, or fix the server URL in Settings → Providers.\n\n" +
      `\`\`\`\n${detail}\n\`\`\``
    )
  }
  return `**Ollama could not complete this turn.**\n\n\`\`\`\n${detail}\n\`\`\``
}

async function describeHttpFailure(response: {
  status: number
  text(): Promise<string>
}): Promise<string> {
  const body = await response.text().catch(() => "")
  const parsed = safeJson(body)
  if (parsed && typeof parsed.error === "string" && parsed.error) {
    return parsed.error
  }
  const tail = body.trim().slice(0, 200)
  return `Ollama returned HTTP ${response.status}${tail ? `: ${tail}` : ""}`
}

type OllamaSessionState = {
  controller?: AbortController
}

export class OllamaAdapter implements AgentAdapter {
  readonly id = "ollama" as const
  readonly available = true
  readonly wantsHistory = true

  private sessions = new Map<string, OllamaSessionState>()

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    this.sessions.set(opts.sessionId, {})
    cb.onSessionEvent({
      type: "session.status",
      id: opts.sessionId,
      status: "idle",
    })
  }

  async send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
    opts?: AdapterSendOpts,
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error("Session not started")
    if (state.controller) {
      throw new Error(
        "This session is already running a turn — stop it or wait for it to finish.",
      )
    }

    const baseUrl = normalizeOllamaBaseUrl(opts?.baseUrl)
    const model = opts?.model?.trim() ?? ""
    const controller = new AbortController()
    state.controller = controller
    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    try {
      if (!model) {
        throw new Error(
          "No model selected. Pick one from the model menu, or pull one with `ollama pull <model>`.",
        )
      }
      const payload = buildOllamaChatPayload({
        model,
        message,
        history: opts?.history,
        systemPrompt: opts?.systemPrompt,
      })
      const response = await this.fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(await describeHttpFailure(response))
      }
      if (!response.body) {
        throw new Error("Ollama sent no response body")
      }

      turn = beginAssistant(sessionId, cb)
      let usage: TurnUsage | undefined
      for await (const line of ndjsonLines(response.body)) {
        const event = parseOllamaChatLine(line)
        if (!event) continue
        if (event.error) throw new Error(event.error)
        if (event.delta) pushDelta(turn, sessionId, event.delta, cb)
        if (event.done) {
          usage = event.usage
          break
        }
      }
      if (usage) cb.onUsage?.(sessionId, usage, turn.messageId)
      finishTurn(turn, sessionId, cb)
      cb.onSessionEvent({
        type: "session.status",
        id: sessionId,
        status: "done",
      })
      cb.onSessionEvent({
        type: "session.ended",
        id: sessionId,
        reason: "done",
      })
    } catch (err) {
      if (controller.signal.aborted) {
        finishTurn(turn, sessionId, cb)
        cb.onSessionEvent({
          type: "session.status",
          id: sessionId,
          status: "idle",
        })
      } else {
        if (!turn) turn = beginAssistant(sessionId, cb)
        pushDelta(turn, sessionId, renderOllamaFailure(baseUrl, err), cb)
        finishTurn(turn, sessionId, cb, "failed")
        cb.onSessionEvent({
          type: "session.status",
          id: sessionId,
          status: "error",
        })
        cb.onSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "error",
        })
      }
    } finally {
      if (state.controller === controller) state.controller = undefined
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.controller?.abort()
  }

  async dispose(sessionId: string): Promise<void> {
    await this.abort(sessionId)
    this.sessions.delete(sessionId)
  }
}
