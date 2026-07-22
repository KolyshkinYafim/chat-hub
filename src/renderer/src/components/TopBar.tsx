import type { GitCheckoutInfo, SessionMeta } from "@shared/types"
import { StatusDot } from "./StatusDot"
import { shortCwd, statusLabel } from "../lib/format"

type Props = {
  session: SessionMeta
  git: GitCheckoutInfo | null
  onAbort: () => void
  onOpenFolder: () => void
  onOpenEditor: () => void
  onCommit: () => void
}

export function TopBar({
  session,
  git,
  onAbort,
  onOpenFolder,
  onOpenEditor,
  onCommit,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">{session.title}</h1>
        <div className="topbar-sub">
          <StatusDot status={session.status} showLabel />
          <span className="sep">·</span>
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
      <div className="topbar-actions">
        {session.status === "running" ? (
          <button type="button" className="tb-btn danger" onClick={onAbort}>
            Stop
          </button>
        ) : null}
        <div className="tb-split">
          <button type="button" className="tb-btn" onClick={onOpenFolder}>
            Open
          </button>
          <button
            type="button"
            className="tb-btn tb-btn-narrow"
            title="Open in editor"
            onClick={onOpenEditor}
          >
            ▾
          </button>
        </div>
        <button
          type="button"
          className="tb-btn"
          onClick={onCommit}
          title="git add -A && git commit"
        >
          Commit
        </button>
        <button
          type="button"
          className="tb-icon"
          title={`${statusLabel[session.status]} · ${session.provider}`}
        >
          ☆
        </button>
      </div>
    </header>
  )
}
