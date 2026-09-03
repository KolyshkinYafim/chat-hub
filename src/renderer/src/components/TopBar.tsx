import { useState } from "react"
import type {
  GitCheckoutInfo,
  ProviderRateLimits,
  SessionMeta,
} from "@shared/types"
import type { ProjectScript } from "@shared/scripts"
import { attentionBadge, needsAction } from "@shared/attention"
import { StatusDot } from "./StatusDot"
import { ScriptsMenu } from "./ScriptsMenu"
import { shortCwd, statusLabel } from "../lib/format"
import { formatQuotaChip, quotaChipTitle } from "../lib/allowance"
import { phaseLabel } from "@shared/live"
import type { LivePhase } from "@shared/types"
import { PanelIcon } from "./surfaces/SurfaceIcon"

type Props = {
  session: SessionMeta
  git: GitCheckoutInfo | null
  dockOpen: boolean
  scripts: ProjectScript[]
  inboxCount: number
  limits?: ProviderRateLimits | null
  phase?: LivePhase | null
  onOpenInbox: () => void
  onRunScript: (script: ProjectScript) => void
  onSaveScripts: (scripts: ProjectScript[]) => Promise<void>
  onToggleDock: () => void
  onOpenFolder: () => void
  onOpenEditor: () => void
  onCommit: () => void
  onRename: () => void
}

export function TopBar({
  session,
  git,
  dockOpen,
  scripts,
  inboxCount,
  limits = null,
  phase = null,
  onOpenInbox,
  onRunScript,
  onSaveScripts,
  onToggleDock,
  onOpenFolder,
  onOpenEditor,
  onCommit,
  onRename,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const badge = attentionBadge(inboxCount)
  const quota = formatQuotaChip(limits)
  const statusHint =
    session.status === "running" && phase !== null
      ? phaseLabel[phase]
      : statusLabel[session.status]
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span title={`${statusHint} · ${session.provider}`}>
          <StatusDot
            status={session.status}
            attention={needsAction(session)}
            phase={phase}
          />
        </span>
        <h1 className="topbar-title">
          <button
            type="button"
            className="title-btn"
            title={`${session.title} — click to rename`}
            onClick={onRename}
          >
            {session.title}
          </button>
        </h1>
        <div className="topbar-meta">
          <span className="mono-soft">{session.project}</span>
          <span className="sep">·</span>
          <span className="mono-soft" title={session.cwd}>
            {shortCwd(session.cwd)}
          </span>
          {git && git.branch !== "no-git" ? (
            <>
              <span className="sep">·</span>
              <span className="mono-soft" title={git.dirty ? "dirty" : "clean"}>
                {git.branch}
                {git.dirty ? " *" : ""}
              </span>
            </>
          ) : null}
          {quota ? (
            <>
              <span className="sep">·</span>
              <span
                className="quota-chip"
                title={quotaChipTitle(limits) ?? undefined}
              >
                {quota}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {/* No Stop here: the only Stop lives next to Send, where the hand is. */}
      <div className="topbar-actions">
        <div className="inbox-entry">
          <button
            type="button"
            className="icon-chip"
            title="Agent inbox (⌥⇧I)"
            aria-label={
              inboxCount > 0
                ? `Agent inbox, ${inboxCount} waiting`
                : "Agent inbox"
            }
            onClick={onOpenInbox}
          >
            <InboxIcon />
          </button>
          {badge ? (
            <span className="inbox-badge" aria-hidden>
              {badge}
            </span>
          ) : null}
        </div>
        <ScriptsMenu
          scripts={scripts}
          onRun={onRunScript}
          onSave={onSaveScripts}
        />
        <div className="tb-split">
          <button
            type="button"
            className="tb-btn"
            title="Open folder in Finder"
            onClick={onOpenFolder}
          >
            Open
          </button>
          <button
            type="button"
            className="tb-btn tb-btn-narrow"
            title="More…"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ▾
          </button>
          {menuOpen ? (
            <>
              <div
                className="menu-backdrop"
                role="presentation"
                onClick={() => setMenuOpen(false)}
              />
              <div className="tb-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenEditor()
                  }}
                >
                  Open in editor
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void navigator.clipboard.writeText(session.cwd)
                  }}
                >
                  Copy path
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenFolder()
                  }}
                >
                  Reveal in Finder
                </button>
              </div>
            </>
          ) : null}
        </div>
        <button
          type="button"
          className="tb-btn"
          onClick={onCommit}
          title="Source control — stage, diff, commit (⌘G)"
        >
          Commit
        </button>
        <button
          type="button"
          className="icon-chip"
          title="Rename session"
          aria-label="Rename session"
          onClick={onRename}
        >
          ✎
        </button>
        <button
          type="button"
          className={`icon-chip panel-toggle ${dockOpen ? "is-on" : ""}`}
          title="Right panel — browser, terminal, files, diff (⌘B)"
          aria-pressed={dockOpen}
          onClick={onToggleDock}
        >
          <PanelIcon open={dockOpen} />
        </button>
      </div>
    </header>
  )
}

function InboxIcon() {
  return (
    <svg
      className="surface-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.2 8.2 3.6 3.4h8.8l1.4 4.8" />
      <path d="M2.2 8.2h3.1l.9 1.6h3.6l.9-1.6h3.1v4.3a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V8.2Z" />
    </svg>
  )
}
