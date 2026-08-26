import { useState } from "react"
import type { GitCheckoutInfo, SessionMeta } from "@shared/types"
import type { ProjectScript } from "@shared/scripts"
import { StatusDot } from "./StatusDot"
import { ScriptsMenu } from "./ScriptsMenu"
import { shortCwd, statusLabel } from "../lib/format"
import { PanelIcon } from "./surfaces/SurfaceIcon"

type Props = {
  session: SessionMeta
  git: GitCheckoutInfo | null
  dockOpen: boolean
  scripts: ProjectScript[]
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
  onRunScript,
  onSaveScripts,
  onToggleDock,
  onOpenFolder,
  onOpenEditor,
  onCommit,
  onRename,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  // Provider/model/permission/effort live in system-banner + composer chips —
  // keep the bar single-line with status, project path and git only.
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span title={`${statusLabel[session.status]} · ${session.provider}`}>
          <StatusDot status={session.status} />
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
        </div>
      </div>
      {/* No Stop here: the only Stop lives next to Send, where the hand is. */}
      <div className="topbar-actions">
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
