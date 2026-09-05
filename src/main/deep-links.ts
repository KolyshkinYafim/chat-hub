import { randomUUID } from "node:crypto"
import { parseDeepLink, type DeepLinkCommand } from "@shared/deep-link"
import {
  HUB_OPS,
  type HubRequest,
  type HubResponse,
} from "@shared/hub-control"

export type DeepLinkNewSession = { project: string | null; prompt: string | null }

export type DeepLinkDeps = {
  hub: (request: HubRequest) => Promise<HubResponse>
  newSession: (input: DeepLinkNewSession) => Promise<HubResponse>
  warn: (reason: string) => void
}

export function automationRequest(
  op: string,
  params: Record<string, unknown>,
): HubRequest {
  return { id: randomUUID(), sessionId: "", op, params }
}

export const DEEP_LINK_PROMPT_PREVIEW_CHARS = 400

export function deepLinkPromptPreview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim()
  return flat.length > DEEP_LINK_PROMPT_PREVIEW_CHARS
    ? `${flat.slice(0, DEEP_LINK_PROMPT_PREVIEW_CHARS - 1)}…`
    : flat
}

export type HubDeepLinkCommand = Exclude<DeepLinkCommand, { kind: "new" }>

export function hubRequestFor(command: HubDeepLinkCommand): HubRequest {
  switch (command.kind) {
    case "session":
      return automationRequest(
        command.window === "new" ? HUB_OPS.openWindow : HUB_OPS.focusSession,
        { sessionId: command.sessionId },
      )
    case "arrange":
      return automationRequest(HUB_OPS.arrange, { preset: command.preset })
    case "surface":
      return automationRequest(HUB_OPS.openSurface, {
        sessionId: command.sessionId,
        surface: command.surface,
      })
  }
}

export class DeepLinkDispatcher {
  private queued: string[] = []
  private ready = false

  constructor(private readonly deps: DeepLinkDeps) {}

  open(url: string): void {
    if (!this.ready) {
      this.queued.push(url)
      return
    }
    void this.run(url)
  }

  markReady(): void {
    this.ready = true
    const replay = this.queued
    this.queued = []
    for (const url of replay) void this.run(url)
  }

  async run(url: string): Promise<HubResponse | null> {
    const parsed = parseDeepLink(url)
    if (!parsed.ok) {
      this.deps.warn(`rejected link: ${parsed.error}`)
      return null
    }
    const response = await this.dispatch(parsed.command)
    if (!response.ok) this.deps.warn(`${parsed.command.kind} failed: ${response.error}`)
    return response
  }

  private dispatch(command: DeepLinkCommand): Promise<HubResponse> {
    if (command.kind === "new") return this.deps.newSession(command)
    return this.deps.hub(hubRequestFor(command))
  }
}
