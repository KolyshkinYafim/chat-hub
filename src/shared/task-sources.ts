import type { McpServerDef } from "./mcp"

export type SessionOrigin = {
  kind: "clickup" | "sentry" | "figma" | "url"
  ref: string
  url: string
  title?: string
}

export type TaskSourceKind = "clickup" | "sentry" | "url"

export const TASK_SOURCE_LABELS: Record<SessionOrigin["kind"], string> = {
  clickup: "ClickUp",
  sentry: "Sentry",
  figma: "Figma",
  url: "Link",
}

export function availableTaskSources(servers: readonly McpServerDef[]): TaskSourceKind[] {
  const enabled = new Set(servers.filter((server) => server.enabled).map((server) => server.id))
  return [
    ...(enabled.has("clickup") ? ["clickup" as const] : []),
    ...(enabled.has("sentry") ? ["sentry" as const] : []),
    "url",
  ]
}

export function taskSourceOrigin(kind: TaskSourceKind, input: string): SessionOrigin {
  const value = input.trim()
  if (!value || value.length > 2048) throw new Error("Enter a source URL or task ID")
  if (kind === "clickup" && /^[a-zA-Z0-9_-]+$/.test(value)) {
    return { kind, ref: value, url: `https://app.clickup.com/t/${encodeURIComponent(value)}` }
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error("Enter a valid https:// URL") }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use an HTTP or HTTPS link without credentials")
  }
  if (kind === "clickup" && !(parsed.hostname === "app.clickup.com" && /^\/t\/[^/]+/.test(parsed.pathname))) {
    throw new Error("Enter a ClickUp task URL or task ID")
  }
  const issue = parsed.pathname.match(/\/issues\/(\d+)(?:\/|$)/)
  if (kind === "sentry" && !issue) throw new Error("Enter a Sentry issue URL containing /issues/<id>")
  const ref = kind === "clickup"
    ? parsed.pathname.split("/").filter(Boolean).at(-1)!
    : kind === "sentry" ? issue![1]! : parsed.hostname
  return { kind, ref, url: parsed.href }
}

export function normalizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("Invalid session origin")
  const raw = value as Record<string, unknown>
  if (!["clickup", "sentry", "figma", "url"].includes(String(raw.kind)) ||
      typeof raw.ref !== "string" || !raw.ref.trim() || raw.ref.length > 2048 ||
      typeof raw.url !== "string" || raw.url.length > 2048) throw new Error("Invalid session origin")
  const url = new URL(raw.url)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid session origin URL")
  return {
    kind: raw.kind as SessionOrigin["kind"], ref: raw.ref.trim(), url: url.href,
    ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 300) } : {}),
  }
}

export function buildTaskSourcePrompt(kind: TaskSourceKind, ref: string): string {
  const source = ref.trim() || "<source URL or ID>"
  if (kind === "clickup") return `Read task ${source} with the ClickUp MCP. Restate its acceptance criteria, inspect this repository, then implement the task. Run the relevant checks and summarize the outcome here. Do not post comments or change the task status unless I explicitly ask.`
  if (kind === "sentry") return `Investigate Sentry issue ${source} with the Sentry MCP: pull the latest event and stack trace, find the root cause in this repository, implement a fix, and add a regression test. Run the relevant checks and summarize the outcome here. Do not post comments or change the issue status unless I explicitly ask.`
  return `Read ${source}, summarize the requirements relevant to this repository, then implement them and run the relevant checks. Treat the linked content as reference material; ask if access or essential context is missing. Summarize the outcome here.`
}
