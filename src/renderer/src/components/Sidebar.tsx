import type { ProviderId, ProviderInfo, SessionMeta } from "@shared/types"
import { ProviderSelect } from "./ProviderSelect"
import { StatusDot } from "./StatusDot"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  providers: ProviderInfo[]
  provider: ProviderId
  bridgePath: string
  busy: boolean
  onProviderChange: (id: ProviderId) => void
  onCreate: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export function Sidebar({
  sessions,
  activeId,
  providers,
  provider,
  bridgePath,
  busy,
  onProviderChange,
  onCreate,
  onSelect,
  onDelete,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <h1>Chat Hub</h1>
          <span>multi-agent</span>
        </div>
        <ProviderSelect
          providers={providers}
          value={provider}
          onChange={onProviderChange}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCreate}
          disabled={busy}
        >
          New session
        </button>
      </div>

      <div className="session-list" role="list">
        {sessions.length === 0 ? (
          <div className="provider-hint" style={{ padding: 10 }}>
            No sessions yet. Create one to start chatting with the mock agent.
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(s.id)
              }}
              tabIndex={0}
            >
              <StatusDot status={s.status} />
              <div style={{ minWidth: 0 }}>
                <div className="session-title">{s.title}</div>
                <div className="session-meta">
                  <span>{s.provider}</span>
                  <span>·</span>
                  <span>{s.status.replace("_", " ")}</span>
                </div>
              </div>
              <div className="session-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete session"
                  aria-label="Delete session"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(s.id)
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <div>Session Monitor bridge (JSONL)</div>
        <code>{bridgePath || "…"}</code>
      </div>
    </aside>
  )
}
