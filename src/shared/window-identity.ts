/**
 * A window tells its renderer who it is through its own URL, because the answer
 * has to be there before any module runs: the layout is read from storage in a
 * `useState` initialiser, long before an IPC round trip could come back.
 */

export const DEFAULT_WINDOW_ID = 1

export type WindowIntent = {
  windowId: number
  /**
   * Ignore whatever panes this id has stored. Set for a window the user just
   * asked for, cleared for one being put back after a restart or a dock click.
   */
  fresh: boolean
  /** The chat the focused pane opens on, when the window was opened for one. */
  sessionId: string | null
}

export function defaultWindowIntent(): WindowIntent {
  return { windowId: DEFAULT_WINDOW_ID, fresh: false, sessionId: null }
}

/** The query string `createWindow` appends to the renderer URL. */
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

/**
 * Where a window keeps its own copy of something. Window 1 keeps the bare key
 * it has always written, so an upgrade finds its panes exactly where it left
 * them and no migration has to run.
 */
export function windowScopedKey(base: string, windowId: number): string {
  return windowId === DEFAULT_WINDOW_ID ? base : `${base}.w${windowId}`
}
