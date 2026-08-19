import { homedir } from "node:os"
import { basename, extname, join } from "node:path"
import { findBinary, isExecutable } from "./binary"
import {
  beginAssistant,
  finishTurn,
  pushDelta,
  toolCallBlock,
  toolResultBlock,
  toolUseBlock,
  type StreamTurn,
} from "./stream-parse"
import { CodexAppServerClient } from "../codex-protocol/client"
import type { ServerNotification } from "../codex-protocol/generated/ServerNotification"
import type { ServerRequest } from "../codex-protocol/generated/ServerRequest"
import type { ThreadItem } from "../codex-protocol/generated/v2/ThreadItem"
import type { ThreadResumeResponse } from "../codex-protocol/generated/v2/ThreadResumeResponse"
import type { ThreadStartResponse } from "../codex-protocol/generated/v2/ThreadStartResponse"
import type { TurnStartResponse } from "../codex-protocol/generated/v2/TurnStartResponse"
import type { UserInput } from "../codex-protocol/generated/v2/UserInput"
import type { ModelListResponse } from "../codex-protocol/generated/v2/ModelListResponse"
import type { AgentInputQuestion, AgentTurnItem, TurnItemStatus, TurnUsage } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
  EffortLevel,
} from "./types"

/**
 * Codex app-server adapter. Each Hub session owns one long-lived JSON-RPC
 * connection and one resumable Codex thread; turns no longer spawn one-shot
 * `codex exec` processes.
 */
const CODEX_NAMES = [
  "codex",
  join(homedir(), ".codex", "bin", "codex"),
  join(homedir(), ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/MacOS/codex",
]

const RETIRED_CODEX_MODELS = new Set([
  "gpt-5-codex",
  "gpt-5",
  "o4-mini",
  "o3",
  "gpt-5.2",
  "gpt-5.3-codex",
])

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const
  private binary: string | null
  private sessions = new Map<string, CodexSessionState>()

  constructor() {
    this.binary = findBinary(CODEX_NAMES)
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(CODEX_NAMES)
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    const bin = opts.binaryPath || this.binary
    if (!bin) {
      throw new Error(
        "Codex CLI not found. Install Codex CLI and ensure `codex` is on PATH.",
      )
    }
    // A bad Settings override must fail here, not as a silent ENOENT per turn.
    if (opts.binaryPath && !isExecutable(opts.binaryPath)) {
      throw new Error(`Codex binary is not executable: ${opts.binaryPath}`)
    }
    this.sessions.set(opts.sessionId, {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      binaryPath: opts.binaryPath,
      threadId: opts.resumeId,
      permissionMode: "yolo",
      callbacks: cb,
    })
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
    const bin = opts?.binaryPath || state.binaryPath || this.binary
    if (!bin) throw new Error("Codex CLI not found")
    if (opts?.binaryPath) state.binaryPath = opts.binaryPath

    if (state.active) {
      throw new Error(
        "This session is already running a turn — stop it or wait for it to finish.",
      )
    }

    const permissionMode = opts?.permissionMode ?? "yolo"
    const client = await this.ensureClient(state, bin, opts?.env)
    state.permissionMode = permissionMode
    state.callbacks = cb
    await this.ensureThread(state, client, cb, opts)
    if (!state.threadId) throw new Error("Codex app-server did not return a thread id")

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    const stream = beginAssistant(sessionId, cb)
    let resolveTurn!: () => void
    let rejectTurn!: (error: Error) => void
    const completed = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    const active: ActiveTurn = {
      stream,
      turnId: "",
      resolve: resolveTurn,
      reject: rejectTurn,
      itemText: new Map(),
    }
    state.active = active
    const selectedModel = currentCodexModel(opts?.model)
    try {
      const response = await client.request<TurnStartResponse>("turn/start", {
        threadId: state.threadId,
        input: buildUserInput(message, opts?.attachments),
        cwd: state.cwd,
        approvalPolicy: approvalPolicy(permissionMode),
        sandboxPolicy: sandboxPolicy(permissionMode, state.cwd),
        model: selectedModel,
        effort: compatibleEffort(state, selectedModel, opts?.effort),
        summary: "concise",
      })
      active.turnId = response.turn.id
      await completed
    } catch (error) {
      if (state.active === active) {
        finishTurn(active.stream, sessionId, cb)
        state.active = undefined
      }
      throw error
    }
  }

  async abort(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state?.client || !state.active || !state.threadId || !state.active.turnId) return
    await state.client.request("turn/interrupt", {
      threadId: state.threadId,
      turnId: state.active.turnId,
    })
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    await this.abort(sessionId)
    await state.client?.close()
    this.sessions.delete(sessionId)
  }

  private async ensureClient(
    state: CodexSessionState,
    binary: string,
    env: Record<string, string> | undefined,
  ): Promise<CodexAppServerClient> {
    if (state.client && state.connectedBinary === binary) return state.client
    await state.client?.close()
    const client = await CodexAppServerClient.connect({
      binary,
      cwd: state.cwd,
      env,
      clientVersion: "0.1.0",
    })
    state.client = client
    state.connectedBinary = binary
    state.threadLoaded = false
    try {
      const catalog = await client.request<ModelListResponse>("model/list", {
        limit: 100,
        includeHidden: false,
      })
      state.modelEfforts = new Map(
        catalog.data.map((model) => [
          model.id,
          new Set(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)),
        ]),
      )
      state.modelDefaults = new Map(
        catalog.data.map((model) => [model.id, model.defaultReasoningEffort]),
      )
      state.defaultModelId = catalog.data.find((model) => model.isDefault)?.id
    } catch (error) {
      console.warn("[codex] model capability discovery failed", error)
      state.modelEfforts = undefined
      state.modelDefaults = undefined
      state.defaultModelId = undefined
    }
    client.onNotification((notification) => this.handleNotification(state, notification))
    client.onServerRequest((request) => void this.handleServerRequest(state, request))
    client.onClose((error) => {
      state.client = undefined
      state.connectedBinary = undefined
      const active = state.active
      if (!active) return
      state.active = undefined
      finishTurn(active.stream, state.sessionId, state.callbacks)
      active.reject(error)
    })
    return client
  }

  private async ensureThread(
    state: CodexSessionState,
    client: CodexAppServerClient,
    cb: AdapterCallbacks,
    opts: AdapterSendOpts | undefined,
  ): Promise<void> {
    if (state.threadLoaded) return
    const common = {
      cwd: state.cwd,
      model: currentCodexModel(opts?.model),
      approvalPolicy: approvalPolicy(state.permissionMode),
      sandbox: sandboxMode(state.permissionMode),
      developerInstructions: opts?.systemPrompt ?? null,
    }
    const response = state.threadId
      ? await client.request<ThreadResumeResponse>("thread/resume", {
          threadId: state.threadId,
          ...common,
        })
      : await client.request<ThreadStartResponse>("thread/start", common)
    state.threadId = response.thread.id
    state.threadLoaded = true
    cb.onAgentSession?.(state.sessionId, response.thread.id)
  }

  private handleNotification(state: CodexSessionState, event: ServerNotification): void {
    const active = state.active
    if (!active) return
    const params = event.params as { threadId?: string; turnId?: string }
    if (params.threadId && params.threadId !== state.threadId) return
    if (params.turnId && active.turnId && params.turnId !== active.turnId) return
    const cb = state.callbacks

    switch (event.method) {
      case "item/agentMessage/delta": {
        const { itemId, delta } = event.params
        active.itemText.set(itemId, (active.itemText.get(itemId) ?? "") + delta)
        pushDelta(active.stream, state.sessionId, delta, cb)
        break
      }
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta } = event.params
        const previous = active.reasoning?.get(itemId) ?? ""
        active.reasoning ??= new Map()
        active.reasoning.set(itemId, previous + delta)
        cb.onTurnItem(state.sessionId, active.stream.messageId, {
          id: itemId,
          kind: "reasoning",
          status: "running",
          summary: previous + delta,
        })
        break
      }
      case "item/commandExecution/outputDelta": {
        const item = active.items?.get(event.params.itemId)
        if (item?.kind === "command") {
          const updated = { ...item, output: (item.output ?? "") + event.params.delta }
          active.items?.set(item.id, updated)
          cb.onTurnItem(state.sessionId, active.stream.messageId, updated)
        }
        break
      }
      case "item/started":
      case "item/completed": {
        this.publishItem(state, event.params.item, event.method === "item/completed")
        break
      }
      case "turn/plan/updated": {
        cb.onTurnItem(state.sessionId, active.stream.messageId, {
          id: "turn-plan",
          kind: "plan",
          status: "running",
          text: event.params.explanation ?? "Plan",
          steps: event.params.plan.map((step) => ({
            text: step.step,
            status: mapPlanStatus(step.status),
          })),
        })
        break
      }
      case "turn/diff/updated": {
        cb.onTurnItem(state.sessionId, active.stream.messageId, {
          id: "turn-diff",
          kind: "file_change",
          status: "running",
          changes: [],
          aggregateDiff: event.params.diff,
        })
        break
      }
      case "thread/tokenUsage/updated": {
        const usage = event.params.tokenUsage.last
        const window = event.params.tokenUsage.modelContextWindow
        active.usage = {
          inputTokens: uncachedInput(usage.inputTokens, usage.cachedInputTokens),
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cachedInputTokens,
          cacheCreateTokens: usage.cacheWriteInputTokens,
          ...(typeof window === "number" && window > 0
            ? { contextWindow: window }
            : {}),
        }
        break
      }
      case "error": {
        cb.onTurnItem(state.sessionId, active.stream.messageId, {
          id: `error-${event.params.turnId}`,
          kind: "error",
          status: "failed",
          message: event.params.error.message,
        })
        break
      }
      case "thread/compacted": {
        cb.onTurnItem(state.sessionId, active.stream.messageId, {
          id: `compaction-${event.params.turnId}`,
          kind: "compaction",
          status: "completed",
        })
        break
      }
      case "serverRequest/resolved":
        cb.onServerRequestResolved?.([
          `codex-${String(event.params.requestId)}`,
          `codex-input-${String(event.params.requestId)}`,
          `codex-mcp-${String(event.params.requestId)}`,
        ])
        break
      case "turn/completed":
        this.completeTurn(state, event.params.turn.status, event.params.turn.error?.message)
        break
    }
  }

  private publishItem(state: CodexSessionState, item: ThreadItem, completed: boolean): void {
    const active = state.active
    if (!active) return
    if (item.type === "agentMessage") {
      const emitted = active.itemText.get(item.id) ?? ""
      if (completed && item.text.length > emitted.length) {
        pushDelta(active.stream, state.sessionId, item.text.slice(emitted.length), state.callbacks)
      }
      return
    }
    const mapped = mapThreadItem(item, completed)
    if (!mapped) return
    active.items ??= new Map()
    active.items.set(mapped.id, mapped)
    state.callbacks.onTurnItem(state.sessionId, active.stream.messageId, mapped)
  }

  private completeTurn(
    state: CodexSessionState,
    status: "completed" | "interrupted" | "failed" | "inProgress",
    errorMessage: string | undefined,
  ): void {
    const active = state.active
    if (!active || status === "inProgress") return
    state.active = undefined
    if (errorMessage) {
      state.callbacks.onTurnItem(state.sessionId, active.stream.messageId, {
        id: `turn-error-${active.turnId}`,
        kind: "error",
        status: "failed",
        message: errorMessage,
      })
    }
    finishTurn(active.stream, state.sessionId, state.callbacks)
    if (active.usage) {
      state.callbacks.onUsage?.(state.sessionId, active.usage, active.stream.messageId)
    }
    const ok = status === "completed"
    state.callbacks.onSessionEvent({
      type: "session.status",
      id: state.sessionId,
      status: ok ? "done" : status === "interrupted" ? "idle" : "error",
    })
    state.callbacks.onSessionEvent({
      type: "session.ended",
      id: state.sessionId,
      reason: ok ? "done" : status === "interrupted" ? "killed" : "error",
    })
    if (status === "failed") active.reject(new Error(errorMessage ?? "Codex turn failed"))
    else active.resolve()
  }

  private async handleServerRequest(state: CodexSessionState, request: ServerRequest): Promise<void> {
    const client = state.client
    if (!client) return
    try {
      if (request.method === "item/commandExecution/requestApproval" ||
          request.method === "item/fileChange/requestApproval") {
        const params = request.params as {
          command?: string | null
          reason?: string | null
          grantRoot?: string | null
          cwd?: string | null
        }
        const isCommand = request.method === "item/commandExecution/requestApproval"
        const summary = isCommand
          ? params.command || params.reason || "Run a command"
          : params.reason || params.grantRoot || "Apply file changes"
        const decision = state.permissionMode === "yolo"
          ? "allow"
          : await state.callbacks.onPermissionRequest?.({
              requestId: `codex-${String(request.id)}`,
              sessionId: state.sessionId,
              agentSessionId: state.threadId ?? state.sessionId,
              source: "codex",
              summary,
              toolName: isCommand ? "Command" : "File change",
              cwd: isCommand ? params.cwd ?? state.cwd : state.cwd,
            }) ?? "deny"
        await client.respond(request.id, {
          decision: decision === "allow" ? "accept" : "decline",
        })
        return
      }
      if (request.method === "item/tool/requestUserInput") {
        const requestId = `codex-input-${String(request.id)}`
        const answers = await state.callbacks.onUserInputRequest?.({
          requestId,
          sessionId: state.sessionId,
          source: "codex",
          questions: request.params.questions.map((question) => ({
            id: question.id,
            header: question.header,
            prompt: question.question,
            options: question.options?.map((option) => ({
              label: option.label,
              description: option.description,
            })),
            secret: question.isSecret,
          })),
        }) ?? {}
        await client.respond(request.id, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
          ),
        })
        return
      }
      if (request.method === "item/permissions/requestApproval") {
        const decision = state.permissionMode === "yolo"
          ? "allow"
          : await state.callbacks.onPermissionRequest?.({
              requestId: `codex-${String(request.id)}`,
              sessionId: state.sessionId,
              agentSessionId: state.threadId ?? state.sessionId,
              source: "codex",
              summary: request.params.reason ?? "Grant additional network or filesystem access",
              toolName: "Permissions",
              cwd: request.params.cwd,
            }) ?? "deny"
        await client.respond(request.id, {
          permissions: decision === "allow"
            ? {
                ...(request.params.permissions.network ? { network: request.params.permissions.network } : {}),
                ...(request.params.permissions.fileSystem ? { fileSystem: request.params.permissions.fileSystem } : {}),
              }
            : {},
          scope: "turn",
        })
        return
      }
      if (request.method === "mcpServer/elicitation/request") {
        const params = request.params
        if (params.mode === "url") {
          const answers = await state.callbacks.onUserInputRequest?.({
            requestId: `codex-mcp-${String(request.id)}`,
            sessionId: state.sessionId,
            source: `mcp:${params.serverName}`,
            questions: [{
              id: "action",
              header: params.serverName,
              prompt: `${params.message}\n${params.url}`,
              options: [{ label: "Accept" }, { label: "Decline" }],
            }],
          }) ?? {}
          const accept = answers.action?.[0] === "Accept"
          await client.respond(request.id, { action: accept ? "accept" : "decline", content: null, _meta: null })
          return
        }
        const questions = schemaQuestions(params.requestedSchema)
        const answers = await state.callbacks.onUserInputRequest?.({
          requestId: `codex-mcp-${String(request.id)}`,
          sessionId: state.sessionId,
          source: `mcp:${params.serverName}`,
          questions: questions.length ? questions : [{ id: "value", header: params.serverName, prompt: params.message }],
        }) ?? {}
        const content = Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, values[0] ?? ""]))
        await client.respond(request.id, { action: Object.keys(answers).length ? "accept" : "decline", content, _meta: null })
        return
      }
      await client.respondError(request.id, {
        code: -32601,
        message: `Chat Hub cannot handle ${request.method} yet`,
      })
    } catch (error) {
      console.warn("[codex] failed to answer server request", request.method, error)
    }
  }
}

type ActiveTurn = {
  stream: StreamTurn
  turnId: string
  resolve: () => void
  reject: (error: Error) => void
  itemText: Map<string, string>
  reasoning?: Map<string, string>
  items?: Map<string, AgentTurnItem>
  usage?: TurnUsage
}

type CodexSessionState = {
  sessionId: string
  cwd: string
  binaryPath?: string
  connectedBinary?: string
  client?: CodexAppServerClient
  threadId?: string
  threadLoaded?: boolean
  permissionMode: PermissionMode
  callbacks: AdapterCallbacks
  active?: ActiveTurn
  modelEfforts?: Map<string, Set<string>>
  modelDefaults?: Map<string, string>
  defaultModelId?: string
}

/**
 * Codex counts cached tokens inside `inputTokens`, while Claude reports them
 * beside it. The shared TurnUsage shape follows Claude, so the cached part is
 * subtracted here rather than teaching every consumer whose dialect it holds.
 */
export function uncachedInput(
  input: number | undefined,
  cached: number | undefined,
): number | undefined {
  if (input === undefined) return undefined
  return Math.max(0, input - (cached ?? 0))
}

function buildUserInput(message: string, attachments: string[] | undefined): UserInput[] {
  return [
    { type: "text", text: message, text_elements: [] },
    ...(attachments ?? []).map((path): UserInput => {
      const image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .includes(extname(path).toLowerCase())
      return image
        ? { type: "localImage", path }
        : { type: "mention", name: basename(path), path }
    }),
  ]
}

function schemaQuestions(schema: unknown): AgentInputQuestion[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return []
  const properties = (schema as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return []
  return Object.entries(properties).map(([id, raw]) => {
    const field = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    const labels = Array.isArray(field.enum)
      ? field.enum.filter((value): value is string => typeof value === "string")
      : field.type === "boolean" ? ["true", "false"] : []
    return {
      id,
      header: typeof field.title === "string" ? field.title : id,
      prompt: typeof field.description === "string" ? field.description : `Enter ${id}`,
      options: labels.length ? labels.map((label) => ({ label })) : undefined,
      secret: field.format === "password",
    }
  })
}

function approvalPolicy(mode: PermissionMode): "never" | "on-request" {
  return mode === "yolo" ? "never" : "on-request"
}

export function currentCodexModel(model: string | undefined): string | null {
  const selected = model?.trim()
  return selected && !RETIRED_CODEX_MODELS.has(selected) ? selected : null
}

function compatibleEffort(
  state: CodexSessionState,
  model: string | null,
  effort: EffortLevel | undefined,
): string | null {
  if (!effort) return null
  const modelId = model ?? state.defaultModelId
  if (!modelId) return effort
  const supported = state.modelEfforts?.get(modelId)
  return selectCompatibleEffort(effort, supported, state.modelDefaults?.get(modelId))
}

export function selectCompatibleEffort(
  requested: string,
  supported: Set<string> | undefined,
  providerDefault: string | undefined,
): string | null {
  if (!supported || supported.has(requested)) return requested
  return providerDefault ?? null
}

function sandboxMode(mode: PermissionMode): "danger-full-access" | "workspace-write" | "read-only" {
  if (mode === "yolo") return "danger-full-access"
  return mode === "acceptEdits" ? "workspace-write" : "read-only"
}

function sandboxPolicy(mode: PermissionMode, cwd: string) {
  if (mode === "yolo") return { type: "dangerFullAccess" as const }
  if (mode === "acceptEdits") {
    return {
      type: "workspaceWrite" as const,
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  return { type: "readOnly" as const, networkAccess: false }
}

function mapItemStatus(status: string, completed: boolean): TurnItemStatus {
  if (!completed || status === "inProgress") return "running"
  if (status === "declined") return "declined"
  if (status === "failed") return "failed"
  return "completed"
}

function mapPlanStatus(status: string): "pending" | "running" | "completed" {
  if (status === "completed") return "completed"
  if (status === "inProgress") return "running"
  return "pending"
}

export function mapThreadItem(item: ThreadItem, completed: boolean): AgentTurnItem | null {
  switch (item.type) {
    case "reasoning":
      return {
        id: item.id,
        kind: "reasoning",
        status: completed ? "completed" : "running",
        summary: item.summary.join("\n"),
      }
    case "plan":
      return { id: item.id, kind: "plan", status: completed ? "completed" : "running", text: item.text }
    case "commandExecution":
      return {
        id: item.id,
        kind: "command",
        status: mapItemStatus(item.status, completed),
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput ?? undefined,
        exitCode: item.exitCode ?? undefined,
        durationMs: item.durationMs ?? undefined,
      }
    case "fileChange":
      return {
        id: item.id,
        kind: "file_change",
        status: mapItemStatus(item.status, completed),
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind.type,
          diff: change.diff,
        })),
      }
    case "mcpToolCall":
      return {
        id: item.id,
        kind: "tool",
        status: mapItemStatus(item.status, completed),
        name: item.tool,
        server: item.server,
        arguments: item.arguments,
        result: item.result ?? undefined,
        error: item.error?.message,
        durationMs: item.durationMs ?? undefined,
      }
    case "dynamicToolCall":
      return {
        id: item.id,
        kind: "tool",
        status: mapItemStatus(item.status, completed),
        name: item.tool,
        server: item.namespace ?? undefined,
        arguments: item.arguments,
        result: item.contentItems ?? undefined,
        durationMs: item.durationMs ?? undefined,
      }
    case "webSearch":
      return { id: item.id, kind: "web_search", status: completed ? "completed" : "running", query: item.query }
    case "imageView":
      return { id: item.id, kind: "image", status: completed ? "completed" : "running", path: item.path }
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { id: item.id, kind: "review", status: completed ? "completed" : "running", text: item.review }
    case "contextCompaction":
      return { id: item.id, kind: "compaction", status: completed ? "completed" : "running" }
    default:
      return null
  }
}

/**
 * One `item.completed` payload → transcript text.
 *
 * Item types verified against codex-cli 0.146.0: agent_message, reasoning,
 * command_execution, file_change, mcp_tool_call, todo_list, web_search, error.
 * An unknown type still gets a card rather than a dumped JSON line — codex
 * adds item types between releases and silence would hide real work.
 */
export function renderCodexItem(item: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const type = str(item.type)

  switch (type) {
    case "agent_message":
      return str(item.text)
    // Reasoning is a summary, not an answer — keeping it out of the bubble is
    // what stops the transcript reading like a stream of consciousness.
    case "reasoning":
      return ""
    case "command_execution": {
      const id = str(item.id) || undefined
      const call = toolUseBlock(
        "Bash",
        { command: str(item.command) || str(item.cmd) },
        id,
      )
      const status = str(item.status)
      if (status !== "completed" && status !== "failed") return call
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined
      const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0)
      return call + toolResultBlock("Bash", str(item.aggregated_output), {
        id,
        exitCode,
        error: failed || undefined,
      })
    }
    case "file_change": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Record<string, unknown>[])
        : []
      const id = str(item.id) || undefined
      const paths = changes.map((change) => str(change.path)).filter(Boolean)
      if (changes.length === 1) return toolCallBlock("Edit", paths[0] ?? "(no changes)", { id, paths })
      const head = changes.map((c) => `${str(c.kind) || "edit"} ${str(c.path)}`)
      return toolCallBlock("Edit", head.join("\n") || "(no changes)", { id, paths })
    }
    case "mcp_tool_call":
      return toolUseBlock(str(item.tool) || str(item.name) || "MCP", item.arguments ?? item.input)
    case "todo_list": {
      const items = Array.isArray(item.items) ? (item.items as Record<string, unknown>[]) : []
      if (!items.length) return ""
      // Same checklist card as Claude TodoWrite / update_plan (not markdown bullets).
      return toolUseBlock(
        "TodoWrite",
        { todos: items },
        str(item.id) || undefined,
      )
    }
    case "update_plan": {
      return toolUseBlock(
        "update_plan",
        {
          explanation: str(item.explanation) || str(item.text),
          plan: item.plan ?? item.steps ?? item.items,
        },
        str(item.id) || undefined,
      )
    }
    case "web_search":
      return toolUseBlock("WebSearch", { pattern: str(item.query) })
    case "error":
      return `\n\n\`\`\`\n${str(item.message) || str(item.text) || "Codex reported an error."}\n\`\`\`\n\n`
    default:
      return toolUseBlock(type || "item", item)
  }
}
