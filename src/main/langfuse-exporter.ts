import { assistantExportText } from "@shared/export-text"
import { createHash } from "node:crypto"
import type { ChatMessage, SessionMeta } from "@shared/types"
import type { LangfuseConfig } from "@shared/langfuse"

type Attribute = { key: string; value: { stringValue: string } }
export type TurnSpan = {
  traceId: string
  spanId: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status: { code: number }
}
const hash = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length)

/** Only the final answer and prompt may leave the app; no tool items or files. */
export function turnSpan(session: SessionMeta, messages: ChatMessage[], userMessageId: string, failed: boolean, metadataOnly: boolean, now = Date.now()): TurnSpan | null {
  const start = messages.findIndex((m) => m.id === userMessageId && m.role === "user")
  if (start < 0) return null
  const user = messages[start]
  const next = messages.findIndex((m, i) => i > start && m.role === "user")
  const replies = messages.slice(start + 1, next < 0 ? undefined : next).filter((m) => m.role === "assistant")
  const last = replies.at(-1)
  const usage = [...replies].reverse().find((m) => m.usage)?.usage
  const values: Record<string, string> = {
    "langfuse.observation.type": "generation",
    "langfuse.session.id": session.id,
    "langfuse.trace.name": metadataOnly ? "Chat Hub session" : session.title,
    "langfuse.observation.metadata.provider": session.provider,
    "langfuse.observation.metadata.project": session.project,
    "langfuse.observation.model.name": session.model ?? "unknown",
    "langfuse.observation.level": failed ? "ERROR" : "DEFAULT",
  }
  if (usage) {
    const details = Object.fromEntries(Object.entries({ input: usage.inputTokens, output: usage.outputTokens, cache_read: usage.cacheReadTokens, cache_creation: usage.cacheCreateTokens }).filter(([, v]) => v !== undefined))
    values["langfuse.observation.usage_details"] = JSON.stringify(details)
    if (usage.costUsd !== undefined) values["langfuse.observation.cost_details"] = JSON.stringify({ total: usage.costUsd })
  }
  if (!metadataOnly) {
    values["langfuse.observation.input"] = JSON.stringify(user.content.slice(0, 100_000))
    values["langfuse.observation.output"] = JSON.stringify(assistantExportText(last?.content ?? "").slice(0, 100_000))
  }
  return {
    traceId: hash(session.id, 32), spanId: hash(`${session.id}:${user.id}`, 16),
    name: `${session.provider} turn`, kind: 1,
    startTimeUnixNano: `${Math.trunc(user.createdAt)}000000`,
    endTimeUnixNano: `${Math.trunc(Math.max(now, user.createdAt))}000000`,
    attributes: Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } })),
    status: { code: failed ? 2 : 1 },
  }
}

export function normalizeLangfuseUrl(value: string): string {
  const url = new URL(value)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Use HTTPS, or HTTP on localhost, without credentials or query parameters.")
  return url.toString().replace(/\/$/, "")
}

type Credentials = { publicKey: string; secretKey: string }
type Pending = { span: TurnSpan; project: string; attempts: number; nextAt: number }
export class LangfuseExporter {
  private queue: Pending[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  lastError: string | null = null
  lastSentAt: number | null = null
  constructor(private readonly settings: () => LangfuseConfig & Credentials, private readonly request: typeof fetch = fetch) {}
  get pending(): number { return this.queue.length }
  start(): void { this.timer ??= setInterval(() => { void this.flush() }, 5000); this.timer.unref() }
  clear(): void { this.queue = [] }
  enqueue(session: SessionMeta, messages: ChatMessage[], messageId: string, failed: boolean): void {
    const config = this.settings()
    if (!config.enabled || !config.publicKey || !config.secretKey || config.excludedProjects.includes(session.baseCwd ?? session.cwd)) return
    const span = turnSpan(session, messages, messageId, failed, config.metadataOnly)
    if (!span) return
    // Bound offline memory; one span is at most 200k text + metadata.
    if (this.queue.length >= 100) { this.queue.shift(); this.lastError = "Queue full: oldest unsent turn discarded." }
    this.queue.push({ span, project: session.baseCwd ?? session.cwd, attempts: 0, nextAt: 0 })
    if (this.queue.length >= 20) void this.flush()
  }
  flush(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = this.sendBatch().finally(() => { this.inflight = null })
    return this.inflight
  }
  private async sendBatch(): Promise<void> {
    const config = this.settings()
    if (!config.enabled) { this.clear(); return }
    this.queue = this.queue.filter((p) => !config.excludedProjects.includes(p.project))
    const batch = this.queue.filter((p) => p.nextAt <= Date.now()).slice(0, 20)
    if (!batch.length || !config.publicKey || !config.secretKey) return
    const sent = new Set(batch)
    this.queue = this.queue.filter((p) => !sent.has(p))
    try {
      const response = await this.request(`${config.baseUrl}/api/public/otel/v1/traces`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`, "x-langfuse-ingestion-version": "4" },
        body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "chat-hub" } }] }, scopeSpans: [{ scope: { name: "chat-hub" }, spans: batch.map((p) => p.span) }] }] }),
      })
      if (!response.ok) throw new Error(`Langfuse returned HTTP ${response.status}`)
      const result = await response.json() as { partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } }
      if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0) {
        // Do not retry an accepted batch: v4 does not deduplicate observations.
        this.lastError = "Langfuse rejected part of the batch. Check server configuration."
        return
      }
      this.lastSentAt = Date.now(); this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Langfuse export failed"
      // Settings may have changed while the request was in flight. Never send
      // old data to new credentials or restore a queue the user disabled.
      const current = this.settings()
      if (JSON.stringify(current) !== JSON.stringify(config)) return
      for (const p of batch) {
        p.attempts++
        if (p.attempts < 3) this.queue.push({ ...p, nextAt: Date.now() + 5000 * 2 ** (p.attempts - 1) })
      }
      this.queue = this.queue.slice(-100)
    }
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }
}
