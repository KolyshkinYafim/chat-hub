import { useState } from "react"
import type {
  GitCheckoutInfo,
  ProviderRateLimits,
  SessionMeta,
} from "@shared/types"
import type { ProjectScript } from "@shared/scripts"
import type { Mode } from "@shared/settings-types"
import { attentionBadge, needsAction } from "@shared/attention"
import { StatusDot } from "./StatusDot"
import { ScriptsEditor, ScriptsMenu } from "./ScriptsMenu"
import { statusLabel } from "../lib/format"
import { formatQuotaChip, quotaChipTitle } from "../lib/allowance"
import { phaseLabel } from "@shared/live"
import type { LivePhase } from "@shared/types"
import { PanelIcon } from "./surfaces/SurfaceIcon"
import { SessionModePicker } from "./SessionModePicker"

type Props = {
  session: SessionMeta
  git: GitCheckoutInfo | null
  dockOpen: boolean
  scripts: ProjectScript[]
  modes: Mode[]
  inboxCount: number
  limits?: ProviderRateLimits | null
  phase?: LivePhase | null
  onOpenInbox: () => void
  onRunScript: (script: ProjectScript) => void
  onSaveScripts: (scripts: ProjectScript[]) => Promise<void>
  onApplyMode: (modeId: string) => void
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
  modes,
  inboxCount,
  limits = null,
  phase = null,
  onOpenInbox,
  onRunScript,
  onSaveScripts,
  onApplyMode,
  onToggleDock,
  onOpenFolder,
  onOpenEditor,
  onCommit,
  onRename,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [scriptsEditorOpen, setScriptsEditorOpen] = useState(false)
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
        <SessionModePicker
          modes={modes}
          modeId={session.modeId}
          onSelect={onApplyMode}
        />
        {inboxCount > 0 ? (
          <div className="inbox-entry">
            <button
              type="button"
              className="icon-chip"
              title="Agent inbox (⌥⇧I)"
              aria-label={`Agent inbox, ${inboxCount} waiting`}
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
        ) : null}
        {scripts.length > 0 ? (
          <ScriptsMenu
            scripts={scripts}
            onRun={onRunScript}
            onSave={onSaveScripts}
          />
        ) : null}
        <button
          type="button"
          className={`tb-btn changes-btn${git?.dirty ? " has-changes" : ""}`}
          onClick={onCommit}
          title="Review changes, stage, and commit (⌘G)"
        >
          Changes{git?.dirty ? " •" : ""}
        </button>
        <div className="topbar-more">
          <button
            type="button"
            className="icon-chip"
            title="Session actions"
            aria-label="Session actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            •••
          </button>
          {menuOpen ? (
            <>
              <div
                className="menu-backdrop"
                role="presentation"
                onClick={() => setMenuOpen(false)}
              />
              <div className="tb-menu topbar-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onRename()
                  }}
                >
                  Rename chat…
                </button>
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
                    onOpenFolder()
                  }}
                >
                  Reveal project folder
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void navigator.clipboard.writeText(session.cwd)
                  }}
                >
                  Copy project path
                </button>
                {scripts.length === 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setScriptsEditorOpen(true)
                    }}
                  >
                    Set up project scripts…
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        <button
          type="button"
          className={`icon-chip panel-toggle ${dockOpen ? "is-on" : ""}`}
          title={`${dockOpen ? "Close" : "Open"} project tools (⌘B)`}
          aria-pressed={dockOpen}
          onClick={onToggleDock}
        >
          <PanelIcon open={dockOpen} />
        </button>
      </div>
      {scriptsEditorOpen ? (
        <ScriptsEditor
          scripts={scripts}
          onSave={onSaveScripts}
          onClose={() => setScriptsEditorOpen(false)}
        />
      ) : null}
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
