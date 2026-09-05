import {
  HUB_PRESETS,
  HUB_SURFACE_CHOICES,
  parseHubPreset,
  parseHubSurfaceChoice,
  type HubPreset,
  type HubSurfaceChoice,
} from "./hub-control"

export const DEEP_LINK_SCHEME = "chat-hub"

const DEEP_LINK_PREFIX = `${DEEP_LINK_SCHEME}://`

export const DEEP_LINK_ROUTES = ["session", "arrange", "new", "surface"] as const

export type DeepLinkWindowChoice = "new" | "front"

export type DeepLinkCommand =
  | { kind: "session"; sessionId: string; window: DeepLinkWindowChoice }
  | { kind: "arrange"; preset: HubPreset }
  | { kind: "new"; project: string | null; prompt: string | null }
  | { kind: "surface"; surface: HubSurfaceChoice; sessionId: string }

export type DeepLinkParse =
  | { ok: true; command: DeepLinkCommand }
  | { ok: false; error: string }

function reject(error: string): DeepLinkParse {
  return { ok: false, error }
}

export function isDeepLink(value: string): boolean {
  return value.toLowerCase().startsWith(DEEP_LINK_PREFIX)
}

export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => isDeepLink(arg)) ?? null
}

export function sessionDeepLink(sessionId: string): string {
  return `${DEEP_LINK_PREFIX}session/${encodeURIComponent(sessionId)}?window=front`
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function routePath(url: URL): string {
  return url.pathname.replace(/^\/+|\/+$/g, "")
}

function singleSegment(url: URL, what: string): DeepLinkParse | string {
  const path = routePath(url)
  if (path === "" || path.includes("/")) {
    return reject(`A ${url.hostname} link needs exactly one ${what} after the slash.`)
  }
  const decoded = decodeSegment(path)
  if (decoded === null || decoded.trim() === "") {
    return reject(`The ${what} in the link is not valid percent-encoding.`)
  }
  return decoded.trim()
}

function noSegments(url: URL): DeepLinkParse | null {
  return routePath(url) === ""
    ? null
    : reject(`A ${url.hostname} link takes query parameters only, not a path.`)
}

function optionalParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)
  return value === null || value.trim() === "" ? null : value.trim()
}

function parseWindowChoice(value: string | null): DeepLinkWindowChoice | null {
  if (value === null || value === "front") return "front"
  if (value === "new") return "new"
  return null
}

function parseSessionRoute(url: URL): DeepLinkParse {
  const sessionId = singleSegment(url, "session id")
  if (typeof sessionId !== "string") return sessionId
  const window = parseWindowChoice(optionalParam(url, "window"))
  if (window === null) {
    return reject('"window" must be "new" or "front".')
  }
  return { ok: true, command: { kind: "session", sessionId, window } }
}

function parseArrangeRoute(url: URL): DeepLinkParse {
  const raw = singleSegment(url, "preset")
  if (typeof raw !== "string") return raw
  const preset = parseHubPreset(raw)
  if (!preset.ok) {
    return reject(`Unknown preset "${raw}". Presets: ${HUB_PRESETS.join(", ")}.`)
  }
  return { ok: true, command: { kind: "arrange", preset: preset.value } }
}

function parseNewRoute(url: URL): DeepLinkParse {
  const stray = noSegments(url)
  if (stray) return stray
  return {
    ok: true,
    command: {
      kind: "new",
      project: optionalParam(url, "project"),
      prompt: optionalParam(url, "prompt"),
    },
  }
}

function parseSurfaceRoute(url: URL): DeepLinkParse {
  const raw = singleSegment(url, "panel kind")
  if (typeof raw !== "string") return raw
  const surface = parseHubSurfaceChoice(raw)
  if (!surface.ok) {
    return reject(
      `Unknown panel "${raw}". Panels: ${HUB_SURFACE_CHOICES.join(", ")}.`,
    )
  }
  const sessionId = optionalParam(url, "session")
  if (sessionId === null) {
    return reject('A surface link needs a "session" query parameter.')
  }
  return { ok: true, command: { kind: "surface", surface: surface.value, sessionId } }
}

export function parseDeepLink(raw: string): DeepLinkParse {
  const trimmed = raw.trim()
  if (!isDeepLink(trimmed)) {
    return reject(`Not a ${DEEP_LINK_SCHEME}:// link.`)
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return reject("The link is not a well-formed URL.")
  }
  switch (url.hostname.toLowerCase()) {
    case "session":
      return parseSessionRoute(url)
    case "arrange":
      return parseArrangeRoute(url)
    case "new":
      return parseNewRoute(url)
    case "surface":
      return parseSurfaceRoute(url)
    default:
      return reject(
        `Unknown route "${url.hostname}". Routes: ${DEEP_LINK_ROUTES.join(", ")}.`,
      )
  }
}
