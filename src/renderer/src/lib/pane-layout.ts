/**
 * The workspace: N chat panes side by side, left to right. Everything here is
 * pure so the arithmetic behind a drag — which seam a pointer is over, what a
 * drop does to the order, what survives a restart — can be tested without a
 * DOM. The renderer holds one `PaneLayout` and replaces it wholesale.
 */

const LAYOUT_KEY = "chat-hub.workspace.panes"
const LAYOUT_VERSION = 1

/** One column of the workspace: a whole chat, not a preview of one. */
export type Pane = {
  id: string
  /** The session on show; null between "make me a pane" and picking a chat. */
  sessionId: string | null
  /** This pane's surface dock. Open/closed belongs to the pane, not the chat. */
  dockOpen: boolean
}

export type PaneLayout = {
  panes: Pane[]
  focusedPaneId: string
}

/**
 * Past six the columns are narrower than the composer is useful at, and the
 * strip scrolls rather than shrinking further — so this is where splitting
 * stops adding one instead.
 */
export const MAX_PANES = 6

/**
 * Below this a transcript stops being readable; the strip scrolls instead.
 * Mirrored by `--pane-min` in styles.css — two panes plus one open dock is
 * exactly what a 1280px window holds, and that is what set the number.
 */
export const MIN_PANE_WIDTH = 340

/** How close to a pane's edge a pointer means "new pane here", not "this one". */
export const DROP_EDGE_PX = 64

export type PaneRect = { id: string; left: number; right: number }

export type DropTarget =
  | { kind: "into"; paneId: string }
  | { kind: "insert"; index: number }

/** The drag payloads the workspace accepts, as `dataTransfer` types. */
export const SESSION_MIME = "application/x-chat-hub-session"
export const PROJECT_MIME = "application/x-chat-hub-project"
export const PANE_MIME = "application/x-chat-hub-pane"

export function soloLayout(
  sessionId: string | null,
  dockOpen: boolean,
): PaneLayout {
  return {
    panes: [{ id: "p1", sessionId, dockOpen }],
    focusedPaneId: "p1",
  }
}

/** `p7` after `p6` — stable and readable, so a persisted layout stays legible. */
export function nextPaneId(layout: PaneLayout): string {
  let highest = 0
  for (const pane of layout.panes) {
    const n = /^p(\d+)$/.exec(pane.id)
    if (n) highest = Math.max(highest, Number.parseInt(n[1] as string, 10))
  }
  return `p${highest + 1}`
}

export function focusedPane(layout: PaneLayout): Pane {
  return (
    layout.panes.find((p) => p.id === layout.focusedPaneId) ??
    (layout.panes[0] as Pane)
  )
}

export function paneForSession(
  layout: PaneLayout,
  sessionId: string,
): Pane | null {
  return layout.panes.find((p) => p.sessionId === sessionId) ?? null
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.focusedPaneId === paneId) return layout
  if (!layout.panes.some((p) => p.id === paneId)) return layout
  return { ...layout, focusedPaneId: paneId }
}

/** ⌘⌥← / ⌘⌥→ — wraps, so the binding never dead-ends on the last pane. */
export function stepFocus(layout: PaneLayout, delta: number): PaneLayout {
  const at = layout.panes.findIndex((p) => p.id === layout.focusedPaneId)
  if (at === -1 || layout.panes.length < 2) return layout
  const count = layout.panes.length
  const next = (((at + delta) % count) + count) % count
  return { ...layout, focusedPaneId: (layout.panes[next] as Pane).id }
}

/**
 * Bind a session to an existing pane. A chat lives in at most one pane, so
 * dropping one that is already open elsewhere swaps the two panes' sessions
 * rather than running the same transcript twice.
 */
export function assignSession(
  layout: PaneLayout,
  paneId: string,
  sessionId: string | null,
): PaneLayout {
  const target = layout.panes.find((p) => p.id === paneId)
  if (!target) return layout
  if (target.sessionId === sessionId) return focusPane(layout, paneId)
  const held =
    sessionId === null
      ? undefined
      : layout.panes.find((p) => p.id !== paneId && p.sessionId === sessionId)
  const panes = layout.panes.map((pane) => {
    if (pane.id === paneId) return { ...pane, sessionId }
    if (held && pane.id === held.id) {
      return { ...pane, sessionId: target.sessionId }
    }
    return pane
  })
  return { panes, focusedPaneId: paneId }
}

/**
 * A drop on a seam. A session already on screen moves to that seam instead of
 * opening twice; a full workspace hands the session to the pane beside the
 * seam rather than silently doing nothing.
 */
export function openPaneAt(
  layout: PaneLayout,
  sessionId: string | null,
  index: number,
  paneId: string,
): PaneLayout {
  const held =
    sessionId === null
      ? undefined
      : layout.panes.find((p) => p.sessionId === sessionId)
  if (held) return movePane(layout, held.id, index)
  if (layout.panes.length >= MAX_PANES) {
    const at = Math.min(layout.panes.length - 1, Math.max(0, index - 1))
    return assignSession(layout, (layout.panes[at] as Pane).id, sessionId)
  }
  const clamped = Math.max(0, Math.min(layout.panes.length, index))
  const pane: Pane = { id: paneId, sessionId, dockOpen: false }
  return {
    panes: [
      ...layout.panes.slice(0, clamped),
      pane,
      ...layout.panes.slice(clamped),
    ],
    focusedPaneId: paneId,
  }
}

/** `index` is a seam in the *current* order, so a right-ward move loses one. */
export function movePane(
  layout: PaneLayout,
  paneId: string,
  index: number,
): PaneLayout {
  const from = layout.panes.findIndex((p) => p.id === paneId)
  if (from === -1) return layout
  const moving = layout.panes[from] as Pane
  const rest = layout.panes.filter((p) => p.id !== paneId)
  const at = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index))
  return {
    panes: [...rest.slice(0, at), moving, ...rest.slice(at)],
    focusedPaneId: paneId,
  }
}

/** Closing a pane closes the view. The session is untouched. */
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.panes.length <= 1) return layout
  const at = layout.panes.findIndex((p) => p.id === paneId)
  if (at === -1) return layout
  const panes = layout.panes.filter((p) => p.id !== paneId)
  const focusedPaneId =
    layout.focusedPaneId === paneId
      ? (panes[Math.min(at, panes.length - 1)] as Pane).id
      : layout.focusedPaneId
  return { panes, focusedPaneId }
}

export function setPaneDock(
  layout: PaneLayout,
  paneId: string,
  open: boolean,
): PaneLayout {
  if (!layout.panes.some((p) => p.id === paneId && p.dockOpen !== open)) {
    return layout
  }
  return {
    ...layout,
    panes: layout.panes.map((pane) =>
      pane.id === paneId ? { ...pane, dockOpen: open } : pane,
    ),
  }
}

/**
 * A deleted session must not leave a pane behind, but a pane deliberately
 * emptied (waiting for a new chat) is not the same thing and stays.
 */
export function pruneLayout(
  layout: PaneLayout,
  live: ReadonlySet<string>,
): PaneLayout {
  const panes = layout.panes.filter(
    (p) => p.sessionId === null || live.has(p.sessionId),
  )
  if (panes.length === layout.panes.length) return layout
  if (panes.length === 0) {
    const first = layout.panes[0] as Pane
    return { panes: [{ ...first, sessionId: null }], focusedPaneId: first.id }
  }
  const focusedPaneId = panes.some((p) => p.id === layout.focusedPaneId)
    ? layout.focusedPaneId
    : (panes[0] as Pane).id
  return { panes, focusedPaneId }
}

/**
 * Which pane a pointer at `x` is proposing. Panes carry an edge band so a drop
 * near a border reads as "a new pane here" rather than "replace this chat";
 * `allowInto` is off while dragging a pane, where only the seams mean anything.
 */
export function resolveDrop(
  x: number,
  rects: readonly PaneRect[],
  opts: { allowInto?: boolean; edge?: number } = {},
): DropTarget | null {
  if (rects.length === 0) return null
  const allowInto = opts.allowInto !== false
  const last = rects.length - 1
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i] as PaneRect
    if (x > rect.right && i < last) continue
    const width = Math.max(1, rect.right - rect.left)
    const edge = Math.min(opts.edge ?? DROP_EDGE_PX, width / 3)
    if (x < rect.left + edge) return { kind: "insert", index: i }
    if (x > rect.right - edge) return { kind: "insert", index: i + 1 }
    if (allowInto) return { kind: "into", paneId: rect.id }
    return { kind: "insert", index: x < (rect.left + rect.right) / 2 ? i : i + 1 }
  }
  return { kind: "insert", index: rects.length }
}

/** A drop that would put a pane back where it already is changes nothing. */
export function isNoopMove(
  layout: PaneLayout,
  paneId: string,
  index: number,
): boolean {
  const at = layout.panes.findIndex((p) => p.id === paneId)
  return at !== -1 && (index === at || index === at + 1)
}

/** How many panes fit before the strip has to scroll sideways. */
export function comfortablePaneCount(
  available: number,
  min = MIN_PANE_WIDTH,
): number {
  return Math.max(1, Math.floor(available / Math.max(1, min)))
}

/**
 * What one pane gets. Below `MIN_PANE_WIDTH` the strip stops dividing and
 * starts scrolling, so the answer never goes under the floor.
 */
export function paneWidth(
  available: number,
  count: number,
  min = MIN_PANE_WIDTH,
): number {
  if (count <= 0) return 0
  return Math.max(min, Math.floor(available / count))
}

export type BrowserClaim = { id: string; wantsBrowser: boolean }

/**
 * One `<webview>` guest at a time. Two live guests mean two Chromium renderers
 * on one persisted partition, so the pane that asked last keeps it and the
 * others show a card offering to take it over. Ownership only moves on a
 * deliberate claim — never because a pane happened to re-render.
 */
export function browserOwnerPane(
  claims: readonly BrowserClaim[],
  preferred: string | null,
): string | null {
  if (
    preferred !== null &&
    claims.some((c) => c.id === preferred && c.wantsBrowser)
  ) {
    return preferred
  }
  return claims.find((c) => c.wantsBrowser)?.id ?? null
}

type StoredLayout = {
  v: number
  panes: Pane[]
  focusedPaneId: string
}

function readPane(value: unknown): Pane | null {
  if (typeof value !== "object" || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || row.id === "") return null
  const sessionId = row.sessionId
  if (sessionId !== null && typeof sessionId !== "string") return null
  return {
    id: row.id,
    sessionId: sessionId ?? null,
    dockOpen: row.dockOpen === true,
  }
}

/** Anything that is not a layout this version wrote reads as "no layout". */
export function parseLayout(raw: string | null): PaneLayout | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const stored = parsed as Partial<StoredLayout>
  if (stored.v !== LAYOUT_VERSION || !Array.isArray(stored.panes)) return null
  const panes: Pane[] = []
  const seen = new Set<string>()
  for (const row of stored.panes) {
    const pane = readPane(row)
    if (!pane || seen.has(pane.id)) continue
    seen.add(pane.id)
    panes.push(pane)
    if (panes.length === MAX_PANES) break
  }
  if (panes.length === 0) return null
  const focusedPaneId =
    typeof stored.focusedPaneId === "string" && seen.has(stored.focusedPaneId)
      ? stored.focusedPaneId
      : (panes[0] as Pane).id
  return { panes, focusedPaneId }
}

export function serializeLayout(layout: PaneLayout): string {
  const stored: StoredLayout = {
    v: LAYOUT_VERSION,
    panes: layout.panes,
    focusedPaneId: layout.focusedPaneId,
  }
  return JSON.stringify(stored)
}

export function loadLayout(fallbackDockOpen: boolean): PaneLayout {
  return (
    parseLayout(localStorage.getItem(LAYOUT_KEY)) ??
    soloLayout(null, fallbackDockOpen)
  )
}

export function hasStoredLayout(): boolean {
  return parseLayout(localStorage.getItem(LAYOUT_KEY)) !== null
}

export function saveLayout(layout: PaneLayout): void {
  localStorage.setItem(LAYOUT_KEY, serializeLayout(layout))
}
