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
  collapsed: boolean
  onToggleCollapsed: () => void
  onProviderChange: (id: ProviderId) => void
  onCreate: (project?: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  onOpenProject: (cwd: string) => void
}

type ProjectGroup = {
  name: string
  cwd: string
  sessions: SessionMeta[]
  collapsed: boolean
}

export function Sidebar({
  sessions,
  activeId,
  providers,
  provider,
  busy,
  collapsed: railCollapsed,
  onToggleCollapsed,
  onProviderChange,
  onCreate,
  onSelect,
  onDelete,
  onOpenSettings,
  onOpenProject,
}: Props) {
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<
    "all" | "waiting" | "running"
  >("all")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    let filtered = sessions
    if (statusFilter === "waiting") {
      filtered = filtered.filter((s) => s.status === "waiting_input")
    } else if (statusFilter === "running") {
      filtered = filtered.filter((s) => s.status === "running")
    }
    if (q) {
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q) ||
          s.provider.toLowerCase().includes(q),
      )
    }

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

    return order.map((name): ProjectGroup => {
      const list = (map.get(name) ?? []).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )
      return {
        name,
        cwd: list[0]?.cwd ?? "",
        sessions: list,
        collapsed: collapsed[name] === true,
      }
    })
  }, [sessions, query, collapsed, statusFilter])

  if (railCollapsed) {
    return (
      <aside className="sidebar rail-collapsed">
        <button
          type="button"
          className="icon-chip rail-expand"
          title="Expand sidebar"
          onClick={onToggleCollapsed}
        >
          »
        </button>
        <button
          type="button"
          className="icon-chip"
          title="Settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
        <button
          type="button"
          className="icon-chip"
          title="New session"
          disabled={busy}
          onClick={() => onCreate()}
        >
          +
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-chrome">
        <div className="brand-row">
          <div className="brand-mark">
            <span className="brand-glyph">⌘</span>
            <div className="brand-name">
              Chat Hub <span className="alpha">MVP</span>
            </div>
          </div>
          <div className="brand-actions">
            <button
              type="button"
              className="icon-chip"
              title="Collapse sidebar"
              onClick={onToggleCollapsed}
            >
              «
            </button>
            <button
              type="button"
              className="icon-chip"
              title="Settings (⌘,)"
              onClick={onOpenSettings}
            >
              ⚙
            </button>
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
        </div>
      </div>

      <div className="projects-label">
        <span>Projects</span>
        <div className="filter-chips">
          {(
            [
              ["all", "All"],
              ["running", "Work"],
              ["waiting", "Wait"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`text-mini filter-chip ${statusFilter === id ? "on" : ""}`}
              onClick={() => setStatusFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="session-scroll" role="tree">
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            No sessions. Create one with a real project folder.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.name} className="project-group" role="group">
              <div className="project-head-row">
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
                <div className="project-hover-actions">
                  <button
                    type="button"
                    className="icon-chip sm"
                    title="Open folder"
                    onClick={() => g.cwd && onOpenProject(g.cwd)}
                  >
                    ↗
                  </button>
                  <button
                    type="button"
                    className="icon-chip sm"
                    title={`New in ${g.name}`}
                    disabled={busy}
                    onClick={() => onCreate(g.name)}
                  >
                    +
                  </button>
                </div>
              </div>
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
                        <div className="session-row-main t3">
                          {s.status === "running" ||
                          s.status === "waiting_input" ? (
                            <StatusDot status={s.status} showLabel />
                          ) : null}
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
            </div>
          ))
        )}
      </div>

      <div className="sidebar-bottom">
        <label className="provider-mini">
          <span>Default agent (new sessions)</span>
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
        <div className="status-legend">
          <span>
            <i className="status-dot running" /> {statusLabel.running}
          </span>
          <span>
            <i className="status-dot waiting_input" />{" "}
            {statusLabel.waiting_input}
          </span>
        </div>
      </div>
    </aside>
  )
}
