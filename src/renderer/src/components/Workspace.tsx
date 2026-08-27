import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent } from "react"
import type { HookRun } from "@shared/hooks"
import type {
  AgentInputRequestInfo,
  ChatMessage,
  GitCheckoutInfo,
  PermissionRequestInfo,
  Project,
  ProviderId,
  ProviderInfo,
  ProviderRateLimits,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  EffortLevel,
  Mode,
  ModelInfo,
  ProviderStatus,
} from "@shared/settings-types"
import type { ProjectScript } from "@shared/scripts"
import type { SurfaceKind } from "../lib/surface-bridge"
import {
  browserOwnerPane,
  PANE_MIME,
  PROJECT_MIME,
  resolveDrop,
  SESSION_MIME,
  type DropTarget,
  type PaneLayout,
} from "../lib/pane-layout"
import type { OnboardNotice } from "./ChatView"
import { WorkspacePane, type PaneActions } from "./WorkspacePane"

export type WorkspaceDrop =
  | { kind: "session"; sessionId: string; target: DropTarget }
  | { kind: "project"; project: Pick<Project, "name" | "cwd">; target: DropTarget }
  | { kind: "pane"; paneId: string; target: DropTarget }

/** A measured pane, wide enough for both the drop maths and the hint it draws. */
type MeasuredPane = {
  id: string
  left: number
  right: number
  top: number
  height: number
}

type Props = {
  layout: PaneLayout
  sessions: SessionMeta[]
  messagesBySession: Record<string, ChatMessage[]>
  usageBySession: Record<string, SessionUsage>
  limitsBySession: Record<string, ProviderRateLimits>
  queuedBySession: Record<string, QueuedMessage[]>
  hooksBySession: Record<string, HookRun[]>
  permissionsBySession: Record<string, PermissionRequestInfo[]>
  inputRequestsBySession: Record<string, AgentInputRequestInfo[]>
  surfaceBySession: Record<string, SurfaceKind>
  diffFocusBySession: Record<string, { path: string; at: number }>
  filesFocusBySession: Record<
    string,
    { path: string; line: number | null; directory: boolean; at: number }
  >
  gitByCwd: Record<string, GitCheckoutInfo | null>
  scriptsByCwd: Record<string, ProjectScript[]>
  overflowHasMore: Record<string, boolean>
  loadingOlderFor: string | null
  sendingIds: ReadonlySet<string>
  highlight: { sessionId: string; messageId: string } | null
  providers: ProviderInfo[]
  providerStatuses: ProviderStatus[]
  fallbackProvider: ProviderId
  modes: Mode[]
  effort: EffortLevel
  permissionMode: PermissionMode
  dockWidth: number
  /** What the sidebar occupies, so each pane's dock clamp can see it. */
  sidebarWidth: number
  gitRefresh: number
  error: string | null
  onboard: OnboardNotice | null
  anyOverlayOpen: boolean
  /** Pane that most recently asked for the one browser guest. */
  browserClaim: string | null
  actions: PaneActions
  onDrop: (drop: WorkspaceDrop) => void
}

const NO_MESSAGES: ChatMessage[] = []
const NO_QUEUED: QueuedMessage[] = []
const NO_PERMISSIONS: PermissionRequestInfo[] = []
const NO_INPUT_REQUESTS: AgentInputRequestInfo[] = []
const NO_HOOKS: HookRun[] = []
const NO_SCRIPTS: ProjectScript[] = []
const NO_MODELS: ModelInfo[] = []

/** The models the picker offers: this session's instance, else its provider. */
function modelsFor(
  session: SessionMeta | null,
  statuses: ProviderStatus[],
  fallback: ProviderId,
): ModelInfo[] {
  if (session) {
    const wanted = session.instanceId ?? session.provider
    const byInstance = statuses.find((s) => s.instanceId === wanted)
    if (byInstance) return byInstance.models
  }
  const id = session?.provider ?? fallback
  return statuses.find((s) => s.id === id && !s.isExtra)?.models ?? NO_MODELS
}

/** Which of our own payloads a drag is carrying, if any. */
function dragKind(types: readonly string[]): WorkspaceDrop["kind"] | null {
  if (types.includes(PANE_MIME)) return "pane"
  if (types.includes(SESSION_MIME)) return "session"
  if (types.includes(PROJECT_MIME)) return "project"
  return null
}

export function Workspace({
  layout,
  sessions,
  messagesBySession,
  usageBySession,
  limitsBySession,
  queuedBySession,
  hooksBySession,
  permissionsBySession,
  inputRequestsBySession,
  surfaceBySession,
  diffFocusBySession,
  filesFocusBySession,
  gitByCwd,
  scriptsByCwd,
  overflowHasMore,
  loadingOlderFor,
  sendingIds,
  highlight,
  providers,
  providerStatuses,
  fallbackProvider,
  modes,
  effort,
  permissionMode,
  dockWidth,
  sidebarWidth,
  gitRefresh,
  error,
  onboard,
  anyOverlayOpen,
  browserClaim,
  actions,
  onDrop,
}: Props) {
  const tiled = layout.panes.length > 1
  const [hint, setHint] = useState<{
    target: DropTarget
    kind: WorkspaceDrop["kind"]
  } | null>(null)
  const measuredRef = useRef<MeasuredPane[] | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const byId = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions],
  )

  // One guest at a time: whichever pane asked last, else the leftmost pane
  // whose dock is showing the browser tab.
  const browserOwner = useMemo(() => {
    const claims = layout.panes.map((pane) => ({
      id: pane.id,
      wantsBrowser:
        pane.dockOpen &&
        pane.sessionId !== null &&
        surfaceBySession[pane.sessionId] === "browser",
    }))
    return browserOwnerPane(claims, browserClaim)
  }, [layout.panes, surfaceBySession, browserClaim])

  const browserHolderTitle = useMemo(() => {
    if (browserOwner === null) return null
    const pane = layout.panes.find((p) => p.id === browserOwner)
    const session = pane?.sessionId ? byId.get(pane.sessionId) : undefined
    return session?.title ?? "another pane"
  }, [browserOwner, layout.panes, byId])

  const measure = useCallback((): MeasuredPane[] => {
    const nodes = document.querySelectorAll<HTMLElement>("[data-pane-id]")
    return Array.from(nodes).map((node) => {
      const box = node.getBoundingClientRect()
      return {
        id: node.dataset.paneId ?? "",
        left: box.left,
        right: box.right,
        top: box.top,
        height: box.height,
      }
    })
  }, [])

  const clearDrag = useCallback(() => {
    measuredRef.current = null
    setHint(null)
  }, [])

  useEffect(() => {
    window.addEventListener("dragend", clearDrag)
    window.addEventListener("drop", clearDrag)
    return () => {
      window.removeEventListener("dragend", clearDrag)
      window.removeEventListener("drop", clearDrag)
    }
  }, [clearDrag])

  // The focused pane has to be on screen for the keyboard walk to mean
  // anything once the strip is wider than the window.
  useEffect(() => {
    if (!tiled) return
    const node = stripRef.current?.querySelector<HTMLElement>(
      `[data-pane-id="${CSS.escape(layout.focusedPaneId)}"]`,
    )
    node?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [tiled, layout.focusedPaneId])

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const kind = dragKind(event.dataTransfer.types)
      if (kind === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = kind === "pane" ? "move" : "copy"
      const rects = (measuredRef.current ??= measure())
      const target = resolveDrop(event.clientX, rects, {
        allowInto: kind !== "pane",
      })
      setHint(target === null ? null : { target, kind })
    },
    [measure],
  )

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setHint(null)
  }, [])

  const onDropEvent = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const kind = dragKind(event.dataTransfer.types)
      if (kind === null) return
      event.preventDefault()
      const rects = measuredRef.current ?? measure()
      const target = resolveDrop(event.clientX, rects, {
        allowInto: kind !== "pane",
      })
      clearDrag()
      if (target === null) return
      if (kind === "pane") {
        const paneId = event.dataTransfer.getData(PANE_MIME)
        if (paneId) onDrop({ kind: "pane", paneId, target })
        return
      }
      if (kind === "session") {
        const sessionId = event.dataTransfer.getData(SESSION_MIME)
        if (sessionId) onDrop({ kind: "session", sessionId, target })
        return
      }
      try {
        const project: unknown = JSON.parse(
          event.dataTransfer.getData(PROJECT_MIME),
        )
        if (
          typeof project === "object" &&
          project !== null &&
          typeof (project as Project).cwd === "string"
        ) {
          const { name, cwd } = project as Project
          onDrop({ kind: "project", project: { name, cwd }, target })
        }
      } catch {
        // A drag from outside the app carrying our type is not worth a banner.
      }
    },
    [clearDrag, measure, onDrop],
  )

  const containerProps = {
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave,
    onDrop: onDropEvent,
  }

  const renderPane = (paneIndex: number) => {
    const pane = layout.panes[paneIndex]
    if (!pane) return null
    const session = pane.sessionId ? (byId.get(pane.sessionId) ?? null) : null
    const sessionId = session?.id ?? null
    const focused = pane.id === layout.focusedPaneId
    return (
      <WorkspacePane
        key={pane.id}
        pane={pane}
        variant={tiled ? "tiled" : "solo"}
        session={session}
        focused={focused}
        surface={sessionId ? (surfaceBySession[sessionId] ?? null) : null}
        ownsBrowser={browserOwner === pane.id}
        browserHeldBy={browserHolderTitle}
        messages={
          sessionId ? (messagesBySession[sessionId] ?? NO_MESSAGES) : NO_MESSAGES
        }
        hasOlderMessages={
          sessionId ? overflowHasMore[sessionId] === true : false
        }
        loadingOlder={loadingOlderFor !== null && loadingOlderFor === sessionId}
        highlightMessageId={
          highlight && highlight.sessionId === sessionId
            ? highlight.messageId
            : null
        }
        usage={sessionId ? (usageBySession[sessionId] ?? null) : null}
        limits={sessionId ? (limitsBySession[sessionId] ?? null) : null}
        queued={sessionId ? (queuedBySession[sessionId] ?? NO_QUEUED) : NO_QUEUED}
        permissions={
          sessionId
            ? (permissionsBySession[sessionId] ?? NO_PERMISSIONS)
            : NO_PERMISSIONS
        }
        inputRequests={
          sessionId
            ? (inputRequestsBySession[sessionId] ?? NO_INPUT_REQUESTS)
            : NO_INPUT_REQUESTS
        }
        hookRuns={sessionId ? (hooksBySession[sessionId] ?? NO_HOOKS) : NO_HOOKS}
        git={session ? (gitByCwd[session.cwd] ?? null) : null}
        scripts={session ? (scriptsByCwd[session.cwd] ?? NO_SCRIPTS) : NO_SCRIPTS}
        models={modelsFor(session, providerStatuses, fallbackProvider)}
        providers={providers}
        modes={modes}
        effort={effort}
        permissionMode={session?.permissionMode ?? permissionMode}
        sending={sessionId !== null && sendingIds.has(sessionId)}
        error={focused ? error : null}
        onboard={focused ? onboard : null}
        anyOverlayOpen={anyOverlayOpen}
        dockWidth={dockWidth}
        sidebarWidth={sidebarWidth}
        gitRefresh={gitRefresh}
        diffFocus={sessionId ? (diffFocusBySession[sessionId] ?? null) : null}
        filesFocus={sessionId ? (filesFocusBySession[sessionId] ?? null) : null}
        sessions={sessions}
        messagesBySession={messagesBySession}
        usageBySession={usageBySession}
        queuedBySession={queuedBySession}
        actions={actions}
        containerProps={tiled ? undefined : containerProps}
      />
    )
  }

  // The hint is fixed-positioned, so it is out of flow in both shells — one
  // pane keeps the grid it has always had, and still shows where a split lands.
  const hintNode = hint ? (
    <DropHint
      hint={hint.target}
      kind={hint.kind}
      rects={measuredRef.current ?? []}
    />
  ) : null

  if (!tiled) {
    return (
      <>
        {renderPane(0)}
        {hintNode}
      </>
    )
  }

  return (
    <div className="workspace" ref={stripRef} {...containerProps}>
      {layout.panes.map((_, index) => renderPane(index))}
      {hintNode}
    </div>
  )
}

/**
 * Where the drop lands, drawn before the button comes up. Fixed-position and
 * measured from the panes themselves, so it costs the layout nothing when no
 * drag is in flight.
 */
function DropHint({
  hint,
  kind,
  rects,
}: {
  hint: DropTarget
  kind: WorkspaceDrop["kind"]
  rects: readonly MeasuredPane[]
}) {
  if (rects.length === 0) return null
  const first = rects[0] as MeasuredPane
  if (hint.kind === "into") {
    const rect = rects.find((r) => r.id === hint.paneId)
    if (!rect) return null
    return (
      <div
        className="drop-hint is-into"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.right - rect.left,
          height: rect.height,
        }}
      >
        <span className="drop-hint-label">Open here</span>
      </div>
    )
  }
  const before = rects[hint.index - 1]
  const after = rects[hint.index]
  const x = after ? after.left : before ? before.right : first.left
  return (
    <div
      className="drop-hint is-seam"
      style={{ top: first.top, left: x, height: first.height }}
    >
      <span className="drop-hint-label">
        {kind === "pane" ? "Move here" : "New pane"}
      </span>
    </div>
  )
}
