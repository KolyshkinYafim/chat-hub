import type { SessionMeta } from "@shared/types"
import { StatusDot } from "./StatusDot"
import { shortCwd, statusLabel } from "../lib/format"

type Props = {
  session: SessionMeta
  onAbort: () => void
}

export function TopBar({ session, onAbort }: Props) {
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
        </div>
      </div>
      <div className="topbar-actions">
        {session.status === "running" ? (
          <button type="button" className="tb-btn danger" onClick={onAbort}>
            Stop
          </button>
        ) : null}
        <button type="button" className="tb-btn primary-soft" disabled title="Coming soon">
          + Add action
        </button>
        <button type="button" className="tb-btn" disabled title="Coming soon">
          Open ▾
        </button>
        <button type="button" className="tb-btn" disabled title="Coming soon">
          Commit ▾
        </button>
        <button
          type="button"
          className="tb-icon"
          disabled
          title={`${statusLabel[session.status]} · ${session.provider}`}
        >
          ☆
        </button>
      </div>
    </header>
  )
}
