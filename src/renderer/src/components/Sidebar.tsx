import { useMemo, useState } from "react"
import type { ProviderId, ProviderInfo, SessionMeta } from "@shared/types"
import { formatRelative, statusLabel } from "../lib/format"
import { StatusDot } from "./StatusDot"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  providers: ProviderInfo[]
  provider: ProviderId
  busy: boolean
  onProviderChange: (id: ProviderId) => void
  onCreate: (project?: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

type ProjectGroup = {
  name: string
  sessions: SessionMeta[]
  collapsed: boolean
}

export function Sidebar({
  sessions,
  activeId,
  providers,
  provider,
  busy,
  onProviderChange,
  onCreate,
  onSelect,
  onDelete,
}: Props) {
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.project.toLowerCase().includes(q) ||
            s.provider.toLowerCase().includes(q),
        )
      : sessions

    const map = new Map<string, SessionMeta[]>()
    for (const s of filtered) {
      const key = s.project || "Workspace"
      const list = map.get(key) ?? []
      list.push(s)
      map.set(key, list)
    }

    const order = [...map.keys()].sort((a, b) => {
      const aT = Math.max(...(map.get(a) ?? []).map((s) => s.updatedAt))
      const bT = Math.max(...(map.get(b) ?? []).map((s) => s.updatedAt))
      return bT - aT
    })

    return order.map(
      (name): ProjectGroup => ({
        name,
        sessions: (map.get(name) ?? []).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
        collapsed: collapsed[name] === true,
      }),
    )
  }, [sessions, query, collapsed])

  return (
    <aside className="sidebar">
      <div className="sidebar-chrome">
        <div className="brand-row">
          <div className="brand-mark">
            <span className="brand-glyph">⌘</span>
            <div>
              <div className="brand-name">
                Chat Hub <span className="alpha">MVP</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="icon-chip"
            title="New session"
            disabled={busy}
            onClick={() => onCreate()}
          >
            +
          </button>
        </div>

        <div className="search-wrap">
          <span className="search-icon" aria-hidden>
            ⌕
          </span>
          <input
            className="search-input"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
          <kbd className="kbd">⌘K</kbd>
        </div>
      </div>

      <div className="projects-label">
        <span>Projects</span>
        <button
          type="button"
          className="text-mini"
          title="Sort"
          onClick={() => {
            /* visual only */
          }}
        >
          ↕
        </button>
      </div>

      <div className="session-scroll" role="tree">
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            No sessions. Create one to start an agent turn.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.name} className="project-group" role="group">
              <button
                type="button"
                className="project-head"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [g.name]: !g.collapsed }))
                }
              >
                <span className={`chev ${g.collapsed ? "" : "open"}`}>▸</span>
                <span className="folder-ico" aria-hidden>
                  📁
                </span>
                <span className="project-name">{g.name}</span>
                <span className="project-count">{g.sessions.length}</span>
              </button>
              {!g.collapsed
                ? g.sessions.map((s) => {
                    const live =
                      s.status === "running" || s.status === "waiting_input"
                    return (
                      <div
                        key={s.id}
                        role="treeitem"
                        aria-selected={s.id === activeId}
                        className={`session-row ${s.id === activeId ? "active" : ""} ${live ? "live" : ""}`}
                        onClick={() => onSelect(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") onSelect(s.id)
                        }}
                        tabIndex={0}
                      >
                        <div className="session-row-main">
                          {s.status === "running" ||
                          s.status === "waiting_input" ? (
                            <StatusDot status={s.status} showLabel />
                          ) : (
                            <span className="session-idle-pad" />
                          )}
                          <span className="session-row-title" title={s.title}>
                            {s.title}
                          </span>
                          <span className="session-row-time">
                            {formatRelative(s.updatedAt)}
                          </span>
                        </div>
                        {s.id === activeId ? (
                          <button
                            type="button"
                            className="row-delete"
                            title="Delete session"
                            onClick={(e) => {
                              e.stopPropagation()
                              onDelete(s.id)
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    )
                  })
                : null}
              {!g.collapsed ? (
                <button
                  type="button"
                  className="new-in-project"
                  disabled={busy}
                  onClick={() => onCreate(g.name)}
                >
                  + New in {g.name}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-bottom">
        <label className="provider-mini">
          <span>Agent</span>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as ProviderId)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {!p.available ? " · install" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="provider-hint-line">
          {providers.find((p) => p.id === provider)?.description}
        </div>
        <div className="status-legend" title="Live status from process events">
          <span>
            <i className="status-dot running" /> {statusLabel.running}
          </span>
          <span>
            <i className="status-dot waiting_input" /> {statusLabel.waiting_input}
          </span>
        </div>
      </div>
    </aside>
  )
}
