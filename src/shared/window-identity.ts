
export const DEFAULT_WINDOW_ID = 1

export type WindowIntent = {
  windowId: number
  fresh: boolean
  sessionId: string | null
}

export function defaultWindowIntent(): WindowIntent {
  return { windowId: DEFAULT_WINDOW_ID, fresh: false, sessionId: null }
}

export function windowQuery(intent: WindowIntent): string {
  const params = new URLSearchParams()
  params.set("windowId", String(intent.windowId))
  if (intent.fresh) params.set("fresh", "1")
  if (intent.sessionId) params.set("session", intent.sessionId)
  return `?${params.toString()}`
}

export function parseWindowIntent(search: string): WindowIntent {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return defaultWindowIntent()
  }
  const raw = Number.parseInt(params.get("windowId") ?? "", 10)
  const windowId =
    Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_WINDOW_ID
  const sessionId = params.get("session")
  return {
    windowId,
    fresh: params.get("fresh") === "1",
    sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
  }
}

export function windowScopedKey(base: string, windowId: number): string {
  return windowId === DEFAULT_WINDOW_ID ? base : `${base}.w${windowId}`
}
