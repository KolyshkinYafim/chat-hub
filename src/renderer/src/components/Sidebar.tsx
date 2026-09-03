import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChatMessage, Project, SessionMeta } from "@shared/types"
import {
  MIN_TRANSCRIPT_QUERY,
  mergeTranscriptHits,
  searchTranscripts,
  type ArchiveSearchResult,
  type TranscriptHit,
} from "@shared/search"
import { formatRelative, statusLabel } from "../lib/format"
import { sessionPhase } from "../lib/live-step"
import { PROJECT_MIME, SESSION_MIME } from "../lib/pane-layout"
import { needsAction } from "@shared/attention"
import { type AttentionSeen } from "../lib/attention"
import {
  partitionSidebarRows,
  type RowContext,
  type RowHold,
} from "../lib/sidebar-rows"
import { StatusDot } from "./StatusDot"
import { ResizeHandle } from "./ResizeHandle"
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "../lib/shell-size"

/** Long enough that a typed word is one archive scan, not one per keystroke. */
const ARCHIVE_SEARCH_DEBOUNCE_MS = 220

const NO_ARCHIVE_HITS: ArchiveSearchResult = { hits: [], truncated: false }

type Props = {
  sessions: SessionMeta[]
  messagesBySession: Record<string, ChatMessage[]>
  projects: Project[]
  activeId: string | null
  attentionSeen: AttentionSeen
  needsYou: SessionMeta[]
  busy: boolean
  collapsed: boolean
  width: number
  /** What the dock occupies right now (0 when closed), so the clamp can see it. */
  dockWidth: number
  /** Live width while dragging; `onWidthCommit` is what gets persisted. */
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  onToggleCollapsed: () => void
  onCreate: (hint?: { project?: string; cwd?: string }) => void
  onSelect: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
  onSettle: (id: string, settled: boolean) => void
  onFavorite: (id: string, favorite: boolean) => void
  onDelete: (id: string) => void
  onOpenInNewWindow: (id: string) => void
  onJumpToMessage: (sessionId: string, messageId: string) => void
  onOpenSettings: () => void
  onOpenSwitcher: () => void
  onShowShortcuts: () => void
  onAddProject: () => void
  onRenameProject: (id: string, name: string) => void
  onRemoveProject: (id: string, name: string) => void
  onOpenProject: (cwd: string) => void
}

type ProjectGroup = {
  key: string
  name: string
  cwd: string
  /** Persisted project id, when this group is a pinned project. */
  projectId: string | null
  sessions: SessionMeta[]
  collapsed: boolean
  sortTs: number
}

export function Sidebar({
  sessions,
  messagesBySession,
  projects,
  activeId,
  attentionSeen,
  needsYou,
  busy,
  collapsed: railCollapsed,
  width,
  dockWidth,
  onWidthChange,
  onWidthCommit,
  onToggleCollapsed,
  onCreate,
  onSelect,
  onArchive,
  onSettle,
  onFavorite,
  onDelete,
  onOpenInNewWindow,
  onJumpToMessage,
  onOpenSettings,
  onOpenSwitcher,
  onShowShortcuts,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onOpenProject,
}: Props) {
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<
    "all" | "waiting" | "running"
  >("all")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [showSettled, setShowSettled] = useState(false)
  const [showFavorites, setShowFavorites] = useState(true)
  const [showNeedsYou, setShowNeedsYou] = useState(true)
  const [rowMenuFor, setRowMenuFor] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const clampWidth = useCallback(
    (px: number) => clampSidebarWidth(px, window.innerWidth, dockWidth),
    [dockWidth],
  )

  useEffect(() => {
    if (!rowMenuFor) return
    const close = () => setRowMenuFor(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [rowMenuFor])

  async function commitRename(id: string) {
    const next = draftTitle.trim()
    setEditingId(null)
    if (!next) return
    try {
      await window.chatHub.renameSession(id, next)
    } catch {
      // The row keeps its previous title; nothing to clean up.
    }
  }

  async function regenerateTitle(id: string) {
    setRegenerating((curr) => new Set(curr).add(id))
    try {
      await window.chatHub.regenerateTitle(id)
    } catch {
      // Best-effort: a failed pass keeps the current title.
    } finally {
      setRegenerating((curr) => {
        const next = new Set(curr)
        next.delete(id)
        return next
      })
    }
  }

  const [archiveHits, setArchiveHits] =
    useState<ArchiveSearchResult>(NO_ARCHIVE_HITS)

  const loadedHits = useMemo(
    () => searchTranscripts(query, messagesBySession),
    [query, messagesBySession],
  )

  // Where each session's loaded transcript starts — the boundary main searches
  // up to. Deriving the effect's dep from this rather than from the messages
  // themselves is what keeps a streaming turn from re-scanning every archive on
  // every token: a token moves no boundary, a loaded archive page does.
  const loadedFrom = useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const [id, list] of Object.entries(messagesBySession)) {
      out[id] = list[0]?.id ?? null
    }
    return out
  }, [messagesBySession])
  const boundaries = useMemo(() => JSON.stringify(loadedFrom), [loadedFrom])
  const loadedFromRef = useRef(loadedFrom)
  useEffect(() => {
    loadedFromRef.current = loadedFrom
  }, [loadedFrom])

  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_TRANSCRIPT_QUERY) {
      setArchiveHits(NO_ARCHIVE_HITS)
      return
    }
    let live = true
    const timer = window.setTimeout(() => {
      void window.chatHub
        .searchArchivedTranscripts(q, loadedFromRef.current)
        .then((result) => {
          if (live) setArchiveHits(result)
        })
        .catch(() => {
          if (live) setArchiveHits(NO_ARCHIVE_HITS)
        })
    }, ARCHIVE_SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query, boundaries])

  const hits = useMemo(
    () => mergeTranscriptHits(loadedHits, archiveHits.hits),
    [loadedHits, archiveHits],
  )

  const searching = query.trim() !== ""
  const statusFiltered = statusFilter !== "all"
  const rowContext = useMemo<RowContext>(
    () => ({ searching, statusFiltered, activeId, seen: attentionSeen }),
    [searching, statusFiltered, activeId, attentionSeen],
  )

  const [dragId, setDragId] = useState<string | null>(null)
  const interactingId = editingId ?? rowMenuFor ?? dragId
  const [hold, setHold] = useState<RowHold | null>(null)
  useEffect(() => {
    if (!interactingId) {
      setHold(null)
      return
    }
    setHold((curr) => {
      if (curr && curr.session.id === interactingId) return curr
      const live = sessions.find((s) => s.id === interactingId)
      if (!live) return null
      return {
        session: live,
        seen: attentionSeen,
        queueIndex: needsYou.findIndex((s) => s.id === interactingId),
      }
    })
  }, [interactingId, sessions, attentionSeen, needsYou])

  const rows = useMemo(
    () => partitionSidebarRows(sessions, needsYou, rowContext, hold),
    [sessions, needsYou, rowContext, hold],
  )

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    let filtered = rows.projects
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
          s.provider.toLowerCase().includes(q) ||
          // A transcript hit keeps the row even when the label says nothing.
          hits.has(s.id),
      )
    }

    // Group by folder (cwd) so a pinned project and its sessions share a group.
    const map = new Map<string, ProjectGroup>()
    const keyFor = (cwd: string, name: string) => cwd || `name:${name}`

    // Seed pinned projects first so empty ones still get a group.
    const showEmpty = statusFilter === "all"
    for (const p of projects) {
      if (!showEmpty) continue
      if (q && !p.name.toLowerCase().includes(q)) continue
      const key = keyFor(p.cwd, p.name)
      map.set(key, {
        key,
        name: p.name,
        cwd: p.cwd,
        projectId: p.id,
        sessions: [],
        collapsed: collapsed[key] === true,
        sortTs: p.createdAt,
      })
    }

    // Fold sessions into groups (creating ad-hoc groups for unpinned folders).
    for (const s of filtered) {
      const name = s.project || "Workspace"
      const key = keyFor(s.cwd, name)
      const existing = map.get(key)
      if (existing) {
        existing.sessions.push(s)
        existing.sortTs = Math.max(existing.sortTs, s.updatedAt)
      } else {
        const pinned = projects.find((p) => p.cwd && p.cwd === s.cwd)
        map.set(key, {
          key,
          name: pinned?.name ?? name,
          cwd: s.cwd,
          projectId: pinned?.id ?? null,
          sessions: [s],
          collapsed: collapsed[key] === true,
          sortTs: s.updatedAt,
        })
      }
    }

    const list = [...map.values()]
    for (const g of list) {
      g.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return list.sort((a, b) => b.sortTs - a.sortTs)
  }, [rows.projects, projects, query, collapsed, statusFilter, hits])

  const transcriptOnly = useMemo(
    () =>
      query.trim()
        ? [...hits.values()].filter((h) => {
            const s = sessions.find((x) => x.id === h.sessionId)
            if (!s || s.archived) return false
            const q = query.trim().toLowerCase()
            return !(
              s.title.toLowerCase().includes(q) ||
              s.project.toLowerCase().includes(q)
            )
          }).length
        : 0,
    [hits, sessions, query],
  )

  function renderRow(s: SessionMeta, isArchived: boolean) {
    const live =
      s.status === "running" ||
      s.status === "waiting_input" ||
      s.status === "error"
    const hit = hits.get(s.id)
    const editing = editingId === s.id
    const regen = regenerating.has(s.id)
    return (
      <div
        key={s.id}
        role="treeitem"
        aria-selected={s.id === activeId}
        className={`session-row ${s.id === activeId ? "active" : ""} ${live ? "live" : ""}`}
        // Dragging a row onto the workspace opens it there; a row being renamed
        // has a text field in it, where a drag would fight the caret.
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "copy"
          e.dataTransfer.setData(SESSION_MIME, s.id)
          e.dataTransfer.setData("text/plain", s.title)
          setDragId(s.id)
        }}
        onDragEnd={() => setDragId(null)}
        onClick={() => onSelect(s.id)}
        onKeyDown={(e) => {
          if (editing) return
          if (e.key === "Enter" || e.key === " ") onSelect(s.id)
        }}
        tabIndex={0}
      >
        <div className="session-row-main t3">
          {live ? (
            <StatusDot
              status={s.status}
              showLabel
              attention={needsAction(s)}
              phase={sessionPhase(s, messagesBySession[s.id])}
            />
          ) : null}
          {editing ? (
            <input
              className="session-title-input"
              value={draftTitle}
              autoFocus
              aria-label="Rename session"
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") void commitRename(s.id)
                if (e.key === "Escape") setEditingId(null)
              }}
              onBlur={() => setEditingId(null)}
            />
          ) : (
            <span
              className={`session-row-title ${regen ? "title-regen" : ""}`}
              title={s.title}
            >
              {s.title}
            </span>
          )}
          <span className="session-row-time">{formatRelative(s.updatedAt)}</span>
        </div>
        {hit ? (
          <button
            type="button"
            className="session-hit"
            title="Jump to this message"
            onClick={(e) => {
              e.stopPropagation()
              onJumpToMessage(s.id, hit.messageId)
            }}
          >
            <span className="session-hit-count">
              {hit.hits} {hit.hits === 1 ? "hit" : "hits"}
            </span>
            <span className="session-hit-text">
              <Marked hit={hit} />
            </span>
          </button>
        ) : null}
        <div className="session-row-actions">
          {!isArchived ? (
            <button
              type="button"
              className={`row-act row-fav ${s.favorite ? "on" : ""}`}
              title={
                s.favorite
                  ? "Remove from Favorites"
                  : "Favorite thread (pins it to the top of the sidebar)"
              }
              onClick={(e) => {
                e.stopPropagation()
                onFavorite(s.id, !s.favorite)
              }}
            >
              {s.favorite ? "★" : "☆"}
            </button>
          ) : null}
          {!isArchived ? (
            <button
              type="button"
              className="row-act"
              title={
                s.settledAt !== undefined
                  ? "Un-settle thread (back to Active)"
                  : "Settle thread (moves it out of Active)"
              }
              onClick={(e) => {
                e.stopPropagation()
                onSettle(s.id, s.settledAt === undefined)
              }}
            >
              {s.settledAt !== undefined ? "↺" : "✓"}
            </button>
          ) : null}
          <button
            type="button"
            className="row-act"
            title="Session menu"
            onClick={(e) => {
              e.stopPropagation()
              setRowMenuFor((m) => (m === s.id ? null : s.id))
            }}
          >
            ⋯
          </button>
          <button
            type="button"
            className="row-act"
            title={
              isArchived
                ? "Unarchive session"
                : "Archive session (hides it, keeps the transcript)"
            }
            onClick={(e) => {
              e.stopPropagation()
              onArchive(s.id, !isArchived)
            }}
          >
            {isArchived ? "⤒" : "⤓"}
          </button>
          <button
            type="button"
            className="row-act row-delete"
            title="Delete session"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(s.id)
            }}
          >
            ×
          </button>
        </div>
        {rowMenuFor === s.id ? (
          <div
            className="session-row-menu"
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="session-row-menu-item"
              onClick={() => {
                setRowMenuFor(null)
                setDraftTitle(s.title)
                setEditingId(s.id)
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="session-row-menu-item"
              disabled={regen}
              onClick={() => {
                setRowMenuFor(null)
                void regenerateTitle(s.id)
              }}
            >
              Regenerate title
            </button>
            <button
              type="button"
              role="menuitem"
              className="session-row-menu-item"
              onClick={() => {
                setRowMenuFor(null)
                onOpenInNewWindow(s.id)
              }}
            >
              Open in new window
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (railCollapsed) {
    const running = sessions.filter((s) => s.status === "running").length
    const waiting = sessions.filter(
      (s) => needsAction(s) && s.status === "waiting_input",
    ).length
    const failed = sessions.filter(
      (s) => needsAction(s) && s.status === "error",
    ).length
    return (
      <aside className="sidebar rail-collapsed">
        <button
          type="button"
          className="icon-chip rail-expand"
          title={
            running || waiting || failed
              ? `Expand sidebar — ${running} running, ${waiting} waiting, ${failed} failed`
              : "Expand sidebar"
          }
          onClick={onToggleCollapsed}
        >
          »
        </button>
        {/* Collapsed, the rail otherwise gives no sign that anything is live —
            the counts are the reason to expand it again. */}
        {running > 0 || waiting > 0 || failed > 0 ? (
          <div className="rail-live" aria-label="Live sessions">
            {running > 0 ? (
              <span className="rail-live-row" title={`${running} running`}>
                <i className="status-dot running" />
                {running}
              </span>
            ) : null}
            {waiting > 0 ? (
              <span className="rail-live-row" title={`${waiting} waiting`}>
                <i className="status-dot attention waiting_input" />
                {waiting}
              </span>
            ) : null}
            {failed > 0 ? (
              <span className="rail-live-row" title={`${failed} failed`}>
                <i className="status-dot attention error" />
                {failed}
              </span>
            ) : null}
          </div>
        ) : null}
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
      <ResizeHandle
        className="sidebar-resizer"
        label="Resize sidebar"
        width={width}
        min={MIN_SIDEBAR_WIDTH}
        max={MAX_SIDEBAR_WIDTH}
        defaultWidth={DEFAULT_SIDEBAR_WIDTH}
        growKey="ArrowRight"
        widthAt={(clientX) => clientX}
        clamp={clampWidth}
        onWidth={onWidthChange}
        onCommit={onWidthCommit}
      />
      <div className="sidebar-chrome">
        <div className="brand-row">
          <div className="brand-mark">
            <span className="brand-glyph">⌘</span>
            <div className="brand-name">Chat Hub</div>
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
              title="New session (⌘N)"
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
            placeholder="Search sessions & messages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation()
                setQuery("")
              }
            }}
            aria-label="Search sessions and transcripts"
          />
          {query ? (
            <button
              type="button"
              className="kbd kbd-btn"
              title="Clear search"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          ) : (
            <button
              type="button"
              className="kbd kbd-btn"
              title="Switch session"
              onClick={onOpenSwitcher}
            >
              ⌘K
            </button>
          )}
        </div>
      </div>

      <div className="projects-label">
        <div className="projects-label-left">
          <span>Projects</span>
          <button
            type="button"
            className="icon-chip"
            title="Add project folder"
            onClick={onAddProject}
          >
            +
          </button>
        </div>
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

      {transcriptOnly > 0 ? (
        <div className="search-note">
          {transcriptOnly} found by message text only
        </div>
      ) : null}

      {archiveHits.truncated ? (
        <div className="search-note search-note-warn">
          Archived history is deeper than one scan — the oldest messages were
          not searched.
        </div>
      ) : null}

      <div className="session-scroll" role="tree">
        {rows.favorites.length > 0 ? (
          <div className="project-group favorites-group" role="group">
            <div className="project-head-row">
              <button
                type="button"
                className="project-head"
                onClick={() => setShowFavorites((v) => !v)}
              >
                <span className={`chev ${showFavorites ? "open" : ""}`}>
                  ▸
                </span>
                <span className="folder-ico" aria-hidden>
                  ★
                </span>
                <span className="project-name">Favorites</span>
                <span className="project-count">{rows.favorites.length}</span>
              </button>
            </div>
            {showFavorites ? rows.favorites.map((s) => renderRow(s, false)) : null}
          </div>
        ) : null}

        {rows.needsYou.length > 0 ? (
          <div className="project-group needs-group" role="group">
            <div className="project-head-row">
              <button
                type="button"
                className="project-head"
                onClick={() => setShowNeedsYou((v) => !v)}
              >
                <span className={`chev ${showNeedsYou ? "open" : ""}`}>▸</span>
                <span className="folder-ico" aria-hidden>
                  ⚑
                </span>
                <span className="project-name">Needs you</span>
                <span className="project-count">{rows.needsYou.length}</span>
              </button>
            </div>
            {showNeedsYou ? rows.needsYou.map((s) => renderRow(s, false)) : null}
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="sidebar-empty">
            {query ? (
              <>
                Nothing matches <b>{query}</b> in titles or transcripts.
                <span className="empty-hint">
                  <span className="kbd">esc</span> clear search
                </span>
              </>
            ) : statusFilter === "waiting" ? (
              <>No session is waiting on you right now.</>
            ) : statusFilter === "running" ? (
              <>No session is running right now.</>
            ) : (
              <>
                No projects yet. Use <b>＋ Add project</b> to pin a folder, or
                start a session.
                <span className="empty-hint">
                  <span className="kbd">⌘N</span> new session
                </span>
              </>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="project-group" role="group">
              <div className="project-head-row">
                <button
                  type="button"
                  className="project-head"
                  // Dropped on the workspace this starts a fresh chat there.
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy"
                    e.dataTransfer.setData(
                      PROJECT_MIME,
                      JSON.stringify({ name: g.name, cwd: g.cwd }),
                    )
                    e.dataTransfer.setData("text/plain", g.name)
                  }}
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [g.key]: !g.collapsed }))
                  }
                >
                  <span className={`chev ${g.collapsed ? "" : "open"}`}>▸</span>
                  <span className="folder-ico" aria-hidden>
                    {g.projectId ? "📌" : "📁"}
                  </span>
                  <span className="project-name" title={g.cwd}>
                    {g.name}
                  </span>
                  <span className="project-count">{g.sessions.length}</span>
                </button>
                <div className="project-hover-actions">
                  {g.projectId ? (
                    <button
                      type="button"
                      className="icon-chip sm"
                      title="Rename project"
                      onClick={() =>
                        onRenameProject(g.projectId as string, g.name)
                      }
                    >
                      ✎
                    </button>
                  ) : null}
                  {/* An ad-hoc group keyed by name has no folder to open; the
                      button was rendering enabled and doing nothing. */}
                  {g.cwd ? (
                    <button
                      type="button"
                      className="icon-chip sm"
                      title="Open folder"
                      onClick={() => onOpenProject(g.cwd)}
                    >
                      ↗
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-chip sm"
                    title={`New in ${g.name}`}
                    disabled={busy}
                    onClick={() => onCreate({ project: g.name, cwd: g.cwd })}
                  >
                    +
                  </button>
                  {g.projectId ? (
                    <button
                      type="button"
                      className="icon-chip sm"
                      title="Remove project from sidebar"
                      onClick={() =>
                        onRemoveProject(g.projectId as string, g.name)
                      }
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
              {!g.collapsed && g.sessions.length === 0 ? (
                <button
                  type="button"
                  className="project-empty-row"
                  disabled={busy}
                  onClick={() => onCreate({ project: g.name, cwd: g.cwd })}
                >
                  No sessions yet · New session…
                </button>
              ) : null}
              {!g.collapsed ? g.sessions.map((s) => renderRow(s, false)) : null}
            </div>
          ))
        )}

        {rows.settled.length > 0 ? (
          <div className="project-group settled-group" role="group">
            <div className="project-head-row">
              <button
                type="button"
                className="project-head"
                onClick={() => setShowSettled((v) => !v)}
              >
                <span className={`chev ${showSettled ? "open" : ""}`}>▸</span>
                <span className="folder-ico" aria-hidden>
                  ✓
                </span>
                <span className="project-name">Settled</span>
                <span className="project-count">{rows.settled.length}</span>
              </button>
            </div>
            {showSettled ? rows.settled.map((s) => renderRow(s, false)) : null}
          </div>
        ) : null}

        {rows.archived.length > 0 ? (
          <div className="project-group archived-group" role="group">
            <div className="project-head-row">
              <button
                type="button"
                className="project-head"
                onClick={() => setShowArchived((v) => !v)}
              >
                <span className={`chev ${showArchived ? "open" : ""}`}>▸</span>
                <span className="folder-ico" aria-hidden>
                  ⤓
                </span>
                <span className="project-name">Archived</span>
                <span className="project-count">{rows.archived.length}</span>
              </button>
            </div>
            {showArchived ? rows.archived.map((s) => renderRow(s, true)) : null}
          </div>
        ) : null}
      </div>

      <div className="sidebar-bottom">
        <div className="status-legend">
          <span>
            <i className="status-dot running" /> {statusLabel.running}
          </span>
          <span>
            <i className="status-dot waiting_input" />{" "}
            {statusLabel.waiting_input}
          </span>
          <span>
            <i className="status-dot error" /> {statusLabel.error}
          </span>
          <button type="button" className="link-btn" onClick={onShowShortcuts}>
            Keys <span className="kbd">⌘/</span>
          </button>
        </div>
      </div>
    </aside>
  )
}

/** Renders a transcript excerpt with the matched run highlighted. */
function Marked({ hit }: { hit: TranscriptHit }) {
  const { snippet, matchStart, matchLength } = hit
  return (
    <>
      {snippet.slice(0, matchStart)}
      <mark>{snippet.slice(matchStart, matchStart + matchLength)}</mark>
      {snippet.slice(matchStart + matchLength)}
    </>
  )
}
