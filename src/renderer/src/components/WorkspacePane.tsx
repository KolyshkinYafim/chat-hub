import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent, HTMLAttributes } from "react"
import type { HookRun } from "@shared/hooks"
import type {
  AgentInputRequestInfo,
  ChatMessage,
  GitCheckoutInfo,
  PermissionRequestInfo,
  ProviderInfo,
  ProviderRateLimits,
  QueueMoveDirection,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import { needsAction } from "@shared/attention"
import type { EffortLevel, Mode, ModelInfo } from "@shared/settings-types"
import type { ProjectScript } from "@shared/scripts"
import { collectAgentActions, editedPathsInMessage } from "../lib/agent-actions"
import type { AttentionSeen } from "../lib/attention"
import { sessionPhase } from "../lib/live-step"
import type { SurfaceKind } from "../lib/surface-bridge"
import type { Pane } from "../lib/pane-layout"
import {
  cockpitTabForSurface,
  surfaceForCockpitTab,
  type CockpitTab,
} from "@shared/cockpit"
import { CockpitTabs } from "./CockpitTabs"
import { ChatView, type OnboardNotice } from "./ChatView"
import { StatusDot } from "./StatusDot"
import { SurfaceDock } from "./surfaces/SurfaceDock"

/**
 * Everything a pane calls back into. Bundled into one object with a stable
 * identity so a pane can be memoized: with N transcripts on screen, a token
 * arriving in one of them must not re-render the other N-1.
 */
export type PaneActions = {
  onFocusPane: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onToggleDock: (paneId: string) => void
  onSelectSurface: (
    paneId: string,
    sessionId: string,
    kind: SurfaceKind | null,
  ) => void
  onClaimBrowser: (paneId: string) => void
  onAutoOpenDiff: (
    paneId: string,
    sessionId: string,
    editedPaths: string[],
  ) => void
  onSelectSession: (sessionId: string) => void
  onSend: (
    sessionId: string,
    text: string,
    opts?: { effort?: EffortLevel; attachments?: string[] },
  ) => Promise<void>
  onAbort: (sessionId: string) => void
  onCancelQueued: (sessionId: string, queuedId: string) => void
  onEditQueued: (sessionId: string, queuedId: string, text: string) => void
  onReorderQueued: (
    sessionId: string,
    queuedId: string,
    direction: QueueMoveDirection,
  ) => void
  onRenameSession: (sessionId: string) => void
  onUnsettle: (sessionId: string) => void
  onModelChange: (sessionId: string, model: string) => void
  onApplyMode: (sessionId: string, modeId: string) => void
  onPermissionChange: (sessionId: string, mode: PermissionMode) => void
  onEffortChange: (effort: EffortLevel) => void
  onOpenFolder: (cwd: string) => void
  onOpenEditor: (cwd: string) => void
  onLoadOlder: (sessionId: string) => void
  onHighlightShown: () => void
  onResolvePermission: (requestId: string, allow: boolean) => void
  onResolveInput: (
    requestId: string,
    answers: Record<string, string[]>,
  ) => void
  onRunScript: (paneId: string, sessionId: string, script: ProjectScript) => void
  onSaveScripts: (cwd: string, scripts: ProjectScript[]) => Promise<void>
  onOpenDiff: (paneId: string, sessionId: string, path: string) => void
  onCreate: () => void
  onShowShortcuts: () => void
  onOpenInbox: () => void
  onGitChanged: () => void
  onDockWidthChange: (width: number) => void
  onDockWidthCommit: (width: number) => void
  onPaneDragStart: (paneId: string, event: DragEvent<HTMLElement>) => void
  onPaneDragEnd: () => void
}

type Props = {
  pane: Pane
  /** `solo` renders the single-pane shell unchanged; `tiled` adds the header. */
  variant: "solo" | "tiled"
  session: SessionMeta | null
  focused: boolean
  surface: SurfaceKind | null
  /** False while another pane holds the one `<webview>` guest. */
  ownsBrowser: boolean
  browserHeldBy: string | null
  messages: ChatMessage[]
  hasOlderMessages: boolean
  loadingOlder: boolean
  transcriptPending: boolean
  highlightMessageId: string | null
  usage: SessionUsage | null
  limits: ProviderRateLimits | null
  queued: QueuedMessage[]
  permissions: PermissionRequestInfo[]
  inputRequests: AgentInputRequestInfo[]
  hookRuns: HookRun[]
  git: GitCheckoutInfo | null
  scripts: ProjectScript[]
  models: ModelInfo[]
  providers: ProviderInfo[]
  modes: Mode[]
  effort: EffortLevel
  permissionMode: PermissionMode
  sending: boolean
  error: string | null
  onboard: OnboardNotice | null
  anyOverlayOpen: boolean
  inboxCount: number
  dockWidth: number
  /** What the sidebar occupies, so the dock's own clamp can see it. */
  sidebarWidth: number
  gitRefresh: number
  diffFocus: { path: string; at: number } | null
  filesFocus: {
    path: string
    line: number | null
    directory: boolean
    at: number
  } | null
  designFocus: { path: string; at: number } | null
  /** Whole-app state the fleet surface lists; only read when that tab is open. */
  sessions: SessionMeta[]
  usageBySession: Record<string, SessionUsage>
  attentionSeen: AttentionSeen
  queuedBySession: Record<string, QueuedMessage[]>
  actions: PaneActions
  containerProps?: HTMLAttributes<HTMLElement>
  cockpit?: boolean
}

function PaneView({
  pane,
  variant,
  session,
  focused,
  surface,
  ownsBrowser,
  browserHeldBy,
  messages,
  hasOlderMessages,
  loadingOlder,
  transcriptPending,
  highlightMessageId,
  usage,
  limits,
  queued,
  permissions,
  inputRequests,
  hookRuns,
  git,
  scripts,
  models,
  providers,
  modes,
  effort,
  permissionMode,
  sending,
  error,
  onboard,
  anyOverlayOpen,
  inboxCount,
  dockWidth,
  sidebarWidth,
  gitRefresh,
  diffFocus,
  filesFocus,
  designFocus,
  sessions,
  usageBySession,
  attentionSeen,
  queuedBySession,
  actions,
  containerProps,
  cockpit = false,
}: Props) {
  const paneId = pane.id
  const sessionId = session?.id ?? null
  const cwd = session?.cwd ?? null
  const dockOpen = pane.dockOpen && session !== null
  const [tab, setTab] = useState<CockpitTab>("chat")

  useEffect(() => {
    if (!cockpit) return
    setTab(cockpitTabForSurface(surface))
  }, [cockpit, surface])

  // The diff surface reads the same tool cards the transcript already parsed,
  // so there is one answer to "what did this turn change" rather than two.
  const agentActions = useMemo(() => collectAgentActions(messages), [messages])
  const panePhase = useMemo(
    () => (session ? sessionPhase(session, messages) : null),
    [messages, session],
  )

  const autoOpenSeenRef = useRef<{ messageId: string; count: number }>({
    messageId: "",
    count: 0,
  })

  // A turn that edits files pulls this pane's dock onto the diff. Only this
  // pane's own turn may do it: a pane the reader is not in must not reach
  // across and rearrange the one they are.
  useEffect(() => {
    if (!sessionId) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant" || !last.streaming) return
    const edited = editedPathsInMessage(last)
    const seen = autoOpenSeenRef.current
    const known = seen.messageId === last.id ? seen.count : 0
    if (edited.length <= known) return
    autoOpenSeenRef.current = { messageId: last.id, count: edited.length }
    actions.onAutoOpenDiff(paneId, sessionId, edited)
  }, [actions, messages, paneId, sessionId])

  const focus = useCallback(() => {
    actions.onFocusPane(paneId)
  }, [actions, paneId])

  const send = useCallback(
    (text: string, opts?: { effort?: EffortLevel; attachments?: string[] }) =>
      sessionId
        ? actions.onSend(sessionId, text, opts)
        : Promise.resolve(undefined),
    [actions, sessionId],
  )

  const selectSurface = useCallback(
    (kind: SurfaceKind | null) => {
      if (!sessionId) return
      actions.onSelectSurface(paneId, sessionId, kind)
    },
    [actions, paneId, sessionId],
  )

  const chat = (
    <ChatView
      session={session}
      sessions={sessions}
      anyOverlayOpen={anyOverlayOpen}
      onboard={onboard}
      highlightMessageId={highlightMessageId}
      onHighlightShown={actions.onHighlightShown}
      usage={usage}
      limits={limits}
      pendingPermissions={permissions}
      onResolvePermission={actions.onResolvePermission}
      pendingInputRequests={inputRequests}
      onResolveInput={actions.onResolveInput}
      messages={messages}
      hasOlderMessages={hasOlderMessages}
      loadingOlder={loadingOlder}
      transcriptPending={transcriptPending}
      onLoadOlder={() => sessionId && actions.onLoadOlder(sessionId)}
      providers={providers}
      models={models}
      modes={modes}
      onApplyMode={(id) => sessionId && actions.onApplyMode(sessionId, id)}
      permissionMode={permissionMode}
      effort={effort}
      git={git}
      error={error}
      sending={sending}
      queued={queued}
      onCancelQueued={(id) =>
        sessionId && actions.onCancelQueued(sessionId, id)
      }
      onEditQueued={(id, text) =>
        sessionId && actions.onEditQueued(sessionId, id, text)
      }
      onReorderQueued={(id, direction) =>
        sessionId && actions.onReorderQueued(sessionId, id, direction)
      }
      onShowShortcuts={actions.onShowShortcuts}
      onModelChange={(m) => sessionId && actions.onModelChange(sessionId, m)}
      onPermissionChange={(m) =>
        sessionId && actions.onPermissionChange(sessionId, m)
      }
      onEffortChange={actions.onEffortChange}
      onSend={send}
      onAbort={() => sessionId && actions.onAbort(sessionId)}
      onCreate={actions.onCreate}
      onOpenFolder={() => cwd && actions.onOpenFolder(cwd)}
      onOpenEditor={() => cwd && actions.onOpenEditor(cwd)}
      onCommit={() => selectSurface("diff")}
      onRename={() => sessionId && actions.onRenameSession(sessionId)}
      onUnsettle={() => sessionId && actions.onUnsettle(sessionId)}
      scripts={scripts}
      onRunScript={(script) =>
        sessionId && actions.onRunScript(paneId, sessionId, script)
      }
      onSaveScripts={(next) =>
        cwd ? actions.onSaveScripts(cwd, next) : Promise.resolve()
      }
      onOpenDiff={(path) =>
        sessionId && actions.onOpenDiff(paneId, sessionId, path)
      }
      dockOpen={dockOpen}
      onToggleDock={() => actions.onToggleDock(paneId)}
      inboxCount={inboxCount}
      onOpenInbox={actions.onOpenInbox}
    />
  )

  const pickTab = useCallback(
    (next: CockpitTab) => {
      setTab(next)
      const kind = surfaceForCockpitTab(next)
      if (!sessionId) return
      actions.onSelectSurface(paneId, sessionId, kind)
    },
    [actions, paneId, sessionId],
  )

  const chatNode = cockpit ? (
    <div className="cockpit-chat" hidden={tab !== "chat"}>
      {chat}
    </div>
  ) : (
    chat
  )

  const column = (
    <>
      {cockpit ? (
        <CockpitTabs
          value={tab}
          onChange={pickTab}
          surfacesEnabled={session !== null}
        />
      ) : null}
      {chatNode}
    </>
  )

  const dockSession = session
  const stageDock = cockpit && tab !== "chat" && dockSession
  const sideDock = !cockpit && dockOpen && dockSession
  const dock =
    (stageDock || sideDock) && dockSession ? (
      <SurfaceDock
        session={dockSession}
        kind={surface ?? surfaceForCockpitTab(tab)}
        width={dockWidth}
        sidebarWidth={sidebarWidth}
        gitRefreshKey={gitRefresh}
        diffFocus={diffFocus}
        filesFocus={filesFocus}
        designFocus={designFocus}
        hookRuns={hookRuns}
        agentActions={agentActions}
        sessions={sessions}
        usageBySession={usageBySession}
        attentionSeen={attentionSeen}
        queuedBySession={queuedBySession}
        browserHeldBy={ownsBrowser ? null : browserHeldBy}
        onTakeBrowser={() => actions.onClaimBrowser(paneId)}
        onSelectSession={actions.onSelectSession}
        onSend={send}
        onGitChanged={actions.onGitChanged}
        onSelectKind={selectSurface}
        onWidthChange={actions.onDockWidthChange}
        onWidthCommit={actions.onDockWidthCommit}
        onClose={() => {
          if (cockpit) pickTab("chat")
          else actions.onToggleDock(paneId)
        }}
        layout={stageDock ? "stage" : "side"}
      />
    ) : null

  if (variant === "solo") {
    return (
      <>
        <div className="main-column" data-pane-id={paneId} {...containerProps}>
          {column}
          {cockpit ? dock : null}
        </div>
        {cockpit ? null : dock}
      </>
    )
  }

  return (
    <section
      className={`pane${focused ? " is-focused" : ""}${
        !cockpit && dockOpen ? " has-dock" : ""
      }`}
      data-pane-id={paneId}
      aria-label={session ? session.title : "Empty pane"}
      onFocusCapture={focus}
      onMouseDownCapture={focus}
      {...containerProps}
    >
      <header
        className="pane-head"
        draggable
        onDragStart={(event) => actions.onPaneDragStart(paneId, event)}
        onDragEnd={actions.onPaneDragEnd}
      >
        <span className="pane-grip" aria-hidden>
          ⋮⋮
        </span>
        {session ? (
          <StatusDot
            status={session.status}
            attention={needsAction(session)}
            phase={panePhase}
          />
        ) : null}
        <span className="pane-head-title" title={session?.cwd}>
          {session ? session.title : "Empty pane — drop a chat here"}
        </span>
        <button
          type="button"
          className="pane-close"
          title="Close this pane (the chat stays in the sidebar)"
          aria-label="Close pane"
          onClick={() => actions.onClosePane(paneId)}
        >
          ×
        </button>
      </header>
      <div className="pane-body">
        <div className="main-column">
          {column}
          {cockpit ? dock : null}
        </div>
        {cockpit ? null : dock}
      </div>
    </section>
  )
}

export const WorkspacePane = memo(PaneView)
