import { useCallback } from "react"
import type { HookRun } from "@shared/hooks"
import type {
  ChatMessage,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import type { AgentAction } from "../../lib/agent-actions"
import type { SurfaceKind } from "../../lib/surface-bridge"
import {
  clampDockWidth,
  DEFAULT_DOCK_WIDTH,
  maxDockWidth,
  MIN_DOCK_WIDTH,
  SURFACE_KINDS,
} from "../../lib/surface-store"
import { ResizeHandle } from "../ResizeHandle"
import { SURFACE_LABEL, SurfaceChooser } from "./SurfaceChooser"
import { SurfaceIcon } from "./SurfaceIcon"
import { BoardSurface } from "./BoardSurface"
import { BrowserSurface } from "./BrowserSurface"
import { ContextSurface } from "./ContextSurface"
import { DiffSurface } from "./DiffSurface"
import { FilesSurface } from "./FilesSurface"
import { FleetSurface } from "./FleetSurface"
import { HistorySurface } from "./HistorySurface"
import { TerminalSurface } from "./TerminalSurface"

type Props = {
  session: SessionMeta
  kind: SurfaceKind | null
  width: number
  /** What the sidebar currently occupies, so the dock leaves the transcript room. */
  sidebarWidth: number
  gitRefreshKey: number
  /** File the transcript asked the Diff panel to show; `at` re-fires a repeat. */
  diffFocus: { path: string; at: number } | null
  /** File (and optional line) project search asked the Files panel to show. */
  filesFocus: { path: string; line: number | null; at: number } | null
  /** Project hooks that have fired for this session (terminal banner). */
  hookRuns?: HookRun[]
  /** Tool calls from the transcript for the Diff audit trail. */
  agentActions?: AgentAction[]
  /** Whole-app session state for the fleet surface. */
  sessions: SessionMeta[]
  messagesBySession: Record<string, ChatMessage[]>
  usageBySession: Record<string, SessionUsage>
  queuedBySession: Record<string, QueuedMessage[]>
  onSelectSession: (id: string) => void
  onGitChanged: () => void
  onSelectKind: (kind: SurfaceKind | null) => void
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  onClose: () => void
}

export function SurfaceDock({
  session,
  kind,
  width,
  sidebarWidth,
  gitRefreshKey,
  diffFocus,
  filesFocus,
  hookRuns = [],
  agentActions = [],
  sessions,
  messagesBySession,
  usageBySession,
  queuedBySession,
  onSelectSession,
  onGitChanged,
  onSelectKind,
  onWidthChange,
  onWidthCommit,
  onClose,
}: Props) {
  const clamp = useCallback(
    (px: number) => clampDockWidth(px, window.innerWidth, sidebarWidth),
    [sidebarWidth],
  )

  return (
    <aside className="surface-dock" aria-label="Surface panel">
      <ResizeHandle
        className="surface-resizer"
        label="Resize panel"
        width={width}
        min={MIN_DOCK_WIDTH}
        max={maxDockWidth(window.innerWidth, sidebarWidth)}
        defaultWidth={DEFAULT_DOCK_WIDTH}
        growKey="ArrowLeft"
        widthAt={(clientX) => window.innerWidth - clientX}
        clamp={clamp}
        onWidth={onWidthChange}
        onCommit={onWidthCommit}
      />
      <header className="surface-head">
        <div className="surface-tabs">
          {SURFACE_KINDS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`surface-tab ${kind === tab ? "active" : ""}`}
              title={
                kind === tab
                  ? `${SURFACE_LABEL[tab]} — click again for the chooser`
                  : SURFACE_LABEL[tab]
              }
              aria-pressed={kind === tab}
              onClick={() => onSelectKind(kind === tab ? null : tab)}
            >
              <SurfaceIcon kind={tab} />
            </button>
          ))}
        </div>
        <span className="surface-head-label">
          {kind === null ? "Surfaces" : SURFACE_LABEL[kind]}
        </span>
        <button
          type="button"
          className="surface-close"
          title="Close panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="surface-body">
        {kind === null ? <SurfaceChooser onPick={onSelectKind} /> : null}
        {kind === "board" ? (
          <BoardSurface
            key={session.id}
            cwd={session.cwd}
            onOpenSurface={onSelectKind}
          />
        ) : null}
        {kind === "context" ? (
          <ContextSurface
            key={session.id}
            cwd={session.cwd}
            onOpenSurface={onSelectKind}
          />
        ) : null}
        {kind === "browser" ? (
          <BrowserSurface key={session.id} sessionId={session.id} />
        ) : null}
        {kind === "terminal" ? (
          <TerminalSurface
            key={session.id}
            cwd={session.cwd}
            sessionId={session.id}
            hookRuns={hookRuns}
          />
        ) : null}
        {kind === "files" ? (
          <FilesSurface key={session.id} cwd={session.cwd} focus={filesFocus} />
        ) : null}
        {kind === "history" ? (
          <HistorySurface
            key={session.id}
            cwd={session.cwd}
            refreshKey={gitRefreshKey}
          />
        ) : null}
        {kind === "fleet" ? (
          <FleetSurface
            sessions={sessions}
            messagesBySession={messagesBySession}
            usageBySession={usageBySession}
            queuedBySession={queuedBySession}
            activeSessionId={session.id}
            onSelectSession={onSelectSession}
          />
        ) : null}
        {kind === "diff" ? (
          <DiffSurface
            key={session.id}
            cwd={session.cwd}
            sessionId={session.id}
            refreshKey={gitRefreshKey}
            focus={diffFocus}
            actions={agentActions}
            onClose={onClose}
            onChanged={onGitChanged}
          />
        ) : null}
      </div>
    </aside>
  )
}
