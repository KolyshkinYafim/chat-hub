import { useCallback } from "react"
import type { HookRun } from "@shared/hooks"
import type {
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import type { AgentAction } from "../../lib/agent-actions"
import type { AttentionSeen } from "../../lib/attention"
import type { SurfaceKind } from "../../lib/surface-bridge"
import {
  clampDockWidth,
  DEFAULT_DOCK_WIDTH,
  maxDockWidth,
  MIN_DOCK_WIDTH,
  SURFACE_KINDS,
} from "../../lib/surface-store"
import { ResizeHandle } from "../ResizeHandle"
import { SURFACE_HINT } from "@shared/surfaces"
import { SURFACE_LABEL, SurfaceChooser } from "./SurfaceChooser"
import { SurfaceIcon } from "./SurfaceIcon"
import { BoardSurface } from "./BoardSurface"
import { BrowserSurface } from "./BrowserSurface"
import { ContextSurface } from "./ContextSurface"
import { DesignSurface } from "./DesignSurface"
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
  designFocus: { path: string; at: number } | null
  /** Project hooks that have fired for this session (terminal banner). */
  hookRuns?: HookRun[]
  /** Tool calls from the transcript for the Diff audit trail. */
  agentActions?: AgentAction[]
  /** Whole-app session state for the fleet surface. */
  sessions: SessionMeta[]
  usageBySession: Record<string, SessionUsage>
  attentionSeen: AttentionSeen
  queuedBySession: Record<string, QueuedMessage[]>
  /**
   * Set when another pane holds the single `<webview>` guest — the browser tab
   * then offers to take it rather than starting a second one.
   */
  browserHeldBy?: string | null
  onTakeBrowser?: () => void
  onSelectSession: (id: string) => void
  onSend: (text: string) => Promise<void>
  onGitChanged: () => void
  onSelectKind: (kind: SurfaceKind | null) => void
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  onClose: () => void
  layout?: "side" | "stage"
}

export function SurfaceDock({
  session,
  kind,
  width,
  sidebarWidth,
  gitRefreshKey,
  diffFocus,
  filesFocus,
  designFocus,
  hookRuns = [],
  agentActions = [],
  sessions,
  usageBySession,
  attentionSeen,
  queuedBySession,
  browserHeldBy = null,
  onTakeBrowser,
  onSelectSession,
  onSend,
  onGitChanged,
  onSelectKind,
  onWidthChange,
  onWidthCommit,
  onClose,
  layout = "side",
}: Props) {
  const clamp = useCallback(
    (px: number) => clampDockWidth(px, window.innerWidth, sidebarWidth),
    [sidebarWidth],
  )

  const staged = layout === "stage"

  return (
    <aside
      className={`surface-dock${staged ? " is-cockpit-stage" : ""}`}
      aria-label="Surface panel"
    >
      {staged ? null : (
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
      )}
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
        {/* The chooser explains every surface; once one is open its own hint
            was the only thing that vanished. Keep it as the header's title. */}
        <span
          className="surface-head-label"
          title={
            kind === null
              ? "Pick what this panel shows"
              : `${SURFACE_LABEL[kind]} — ${SURFACE_HINT[kind]}`
          }
        >
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
        {kind === "browser" && browserHeldBy !== null ? (
          <div className="surface-claim">
            <p className="surface-claim-text">
              The browser is live in <strong>{browserHeldBy}</strong>. One page
              at a time keeps a single guest on the shared profile.
            </p>
            <button type="button" className="tb-btn" onClick={onTakeBrowser}>
              Move it here
            </button>
          </div>
        ) : null}
        {kind === "browser" && browserHeldBy === null ? (
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
        {kind === "design" ? (
          <DesignSurface
            key={session.id}
            cwd={session.cwd}
            focus={designFocus}
          />
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
            usageBySession={usageBySession}
            attentionSeen={attentionSeen}
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
            onSend={onSend}
            onClose={onClose}
            onChanged={onGitChanged}
          />
        ) : null}
      </div>
    </aside>
  )
}
