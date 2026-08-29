import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import type { HookRun } from "@shared/hooks"
import type {
  ChatMessage,
  AgentInputRequestInfo,
  GitCheckoutInfo,
  HubEvent,
  PermissionRequestInfo,
  Project,
  ProviderId,
  ProviderInfo,
  ProviderRateLimits,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type {
  EffortLevel,
  Mode,
  ProviderStatus,
} from "@shared/settings-types"
import { DEFAULT_MODES } from "@shared/settings-types"
import { resolveTheme } from "@shared/theme"
import { applyTheme } from "./lib/theme-apply"
import { projectFromCwd } from "@shared/project"
import { clearMigratedArchive, readArchivedForMigration } from "./lib/archive"
import type { ProjectScript } from "@shared/scripts"
import { pruneDiffComments } from "./lib/diff-comments"
import { prunePendingRuns, stashBrowserUrl, stashTerminalCommand } from "./lib/pending-run"
import { prunePendingPrompts } from "./lib/pending-prompt"
import { prunePreviewPicks } from "./lib/preview-picks"
import { pruneScriptTerminals } from "./lib/script-terminals"
import { mergeReplacedMessages } from "./lib/transcript-window"
import { applyStatusesToProviders } from "./lib/provider-status"
import { Sidebar } from "./components/Sidebar"
import { Workspace, type WorkspaceDrop } from "./components/Workspace"
import type { PaneActions } from "./components/WorkspacePane"
import type { SurfaceKind } from "./lib/surface-bridge"
import {
  assignSession,
  closePane,
  focusedPane,
  focusPane,
  isNoopMove,
  loadLayout,
  movePane,
  nextPaneId,
  openPaneAt,
  PANE_MIME,
  paneForSession,
  pruneLayout,
  saveLayout,
  setPaneDock,
  soloLayout,
  stepFocus,
  type DropTarget,
  type PaneLayout,
} from "./lib/pane-layout"
import {
  clampDockWidth,
  loadAutoOpenDock,
  loadDockOpen,
  loadDockWidth,
  loadSurfaceBySession,
  saveAutoOpenDock,
  saveDockOpen,
  saveDockWidth,
  saveSurfaceBySession,
  shouldAutoOpenDock,
} from "./lib/surface-store"
import {
  clampSidebarWidth,
  MIN_FIT_VIEWPORT,
  loadSidebarWidth,
  RAIL_WIDTH,
  saveSidebarWidth,
} from "./lib/shell-size"
import { useAttention } from "./lib/use-attention"
import { isEditableTarget } from "./lib/editable-target"
import { SettingsModal } from "./components/SettingsModal"
import {
  NewSessionDialog,
  type NewSessionDraft,
} from "./components/NewSessionDialog"
import { FirstRunWizard } from "./components/FirstRunWizard"
import { CommandPalette } from "./components/CommandPalette"
import {
  ProjectSearch,
  type ProjectSearchMode,
} from "./components/ProjectSearch"
import { ShortcutsOverlay } from "./components/ShortcutsOverlay"

/**
 * The auth nag lives in the renderer: settings has no field for it, and a
 * dismissal that dies with the window is worse than no button at all.
 */
const AUTH_NAG_KEY = "chat-hub.authNagDismissed"

/** The terminal needs one mounted beat to start the script before the browser takes the dock. */
const SCRIPT_PREVIEW_SWITCH_MS = 800

export default function App() {
  const windowIntent = window.chatHub.windowIntent
  const windowId = windowIntent.windowId
  const [booted, setBooted] = useState(false)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({})
  /** Transcript overflow: more pages available in archive.jsonl for this id. */
  const [overflowHasMore, setOverflowHasMore] = useState<
    Record<string, boolean>
  >({})
  /** The session whose scroll-back is being fetched, if any. */
  const [loadingOlderFor, setLoadingOlderFor] = useState<string | null>(null)
  const loadingOlderRef = useRef<string | null>(null)
  // A window opened on purpose starts on a solo layout — the panes stored under
  // its id belong to the window it is replacing, and reviving them would make
  // "new window" look like it reopened an old one.
  const [layout, setLayout] = useState<PaneLayout>(() =>
    windowIntent.fresh
      ? soloLayout(windowIntent.sessionId, loadDockOpen(windowId))
      : loadLayout(loadDockOpen(windowId), windowId),
  )
  const [projects, setProjects] = useState<Project[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>(
    [],
  )
  const [provider, setProvider] = useState<ProviderId>("claude")
  const [modes, setModes] = useState<Mode[]>(DEFAULT_MODES)
  const [effort, setEffort] = useState<EffortLevel>("high")
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionHint, setNewSessionHint] = useState<{
    project?: string
    cwd?: string
    /** Pane the finished session lands in; a fresh one when a drop made it. */
    paneId?: string
  }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [gitByCwd, setGitByCwd] = useState<
    Record<string, GitCheckoutInfo | null>
  >({})
  const [dockWidth, setDockWidth] = useState(loadDockWidth)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [surfaceBySession, setSurfaceBySession] = useState<
    Record<string, SurfaceKind>
  >(loadSurfaceBySession)
  const [autoOpenDock, setAutoOpenDock] = useState(loadAutoOpenDock)
  const [gitRefresh, setGitRefresh] = useState(0)
  /** Pane that most recently asked for the single `<webview>` browser guest. */
  const [browserClaim, setBrowserClaim] = useState<string | null>(null)
  // `at` re-fires the focus even when the same path is clicked twice.
  const [diffFocusBySession, setDiffFocusBySession] = useState<
    Record<string, { path: string; at: number }>
  >({})
  const [filesFocusBySession, setFilesFocusBySession] = useState<
    Record<
      string,
      {
        path: string
        line: number | null
        /** A folder to expand rather than a file to open. */
        directory: boolean
        at: number
      }
    >
  >({})
  const [projectSearch, setProjectSearch] = useState<ProjectSearchMode | null>(
    null,
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [onboardDismissed, setOnboardDismissed] = useState(
    () => localStorage.getItem(AUTH_NAG_KEY) === "1",
  )
  const [queuedBySession, setQueuedBySession] = useState<
    Record<string, QueuedMessage[]>
  >({})
  const [usageBySession, setUsageBySession] = useState<
    Record<string, SessionUsage>
  >({})
  const [limitsBySession, setLimitsBySession] = useState<
    Record<string, ProviderRateLimits>
  >({})
  const [permissions, setPermissions] = useState<PermissionRequestInfo[]>([])
  const [inputRequests, setInputRequests] = useState<AgentInputRequestInfo[]>([])
  /** Project hooks that have run, keyed by session id (oldest first). */
  const [hooksBySession, setHooksBySession] = useState<
    Record<string, HookRun[]>
  >({})
  const [scriptsByCwd, setScriptsByCwd] = useState<
    Record<string, ProjectScript[]>
  >({})
  const [highlight, setHighlight] = useState<{
    sessionId: string
    messageId: string
  } | null>(null)

  const pane = focusedPane(layout)
  const activeId = pane.sessionId

  const activeIdRef = useRef<string | null>(activeId)
  const overflowRef = useRef(overflowHasMore)
  const layoutRef = useRef(layout)
  const sessionsRef = useRef(sessions)
  const selectSessionRef = useRef<(id: string) => void>(() => {})
  // Read after an await, where the value this render closed over is already old.
  const messagesBySessionRef = useRef(messagesBySession)
  // applyEvent below is a stable (empty-deps) callback bridging main-process
  // events into state; it needs the latest dock/surface/pref values without
  // taking them as deps (which would re-subscribe the IPC listener on every
  // toggle), so they ride in refs kept fresh by the effects further down.
  const surfaceBySessionRef = useRef(surfaceBySession)
  const autoOpenDockRef = useRef(autoOpenDock)

  const jumpToSession = useCallback((id: string) => {
    selectSessionRef.current(id)
  }, [])
  const attention = useAttention(sessions, layout, activeId, jumpToSession)

  useEffect(() => {
    window.chatHub.reportAttentionCount(attention.queue.length)
  }, [attention.queue.length])

  const applyEvent = useCallback((event: HubEvent) => {
    switch (event.type) {
      case "sessions.replaced":
        setSessions(event.sessions)
        break
      case "queue.changed":
        setQueuedBySession((curr) => ({
          ...curr,
          [event.sessionId]: event.queued,
        }))
        break
      case "session.active":
        // The notch island focuses a session by pushing this event straight at
        // the renderer, so adopt it exactly like a sidebar click — otherwise
        // main keeps (and persists) the previous session as the active one.
        if (event.sessionId && event.sessionId !== activeIdRef.current) {
          selectSessionRef.current(event.sessionId)
        } else if (!event.sessionId) {
          setLayout((curr) => assignSession(curr, curr.focusedPaneId, null))
        }
        break
      case "session.upsert":
        setSessions((curr) => {
          const idx = curr.findIndex((s) => s.id === event.session.id)
          if (idx === -1) return [event.session, ...curr]
          const next = curr.slice()
          next[idx] = event.session
          return next.sort((a, b) => b.updatedAt - a.updatedAt)
        })
        break
      case "session.status":
        setSessions((curr) =>
          curr.map((s) => {
            if (s.id !== event.id) return s
            const at = event.at
            const activityAt =
              at === undefined ? s.activityAt : Math.max(s.activityAt ?? 0, at)
            const updatedAt =
              at === undefined ? s.updatedAt : Math.max(s.updatedAt, at)
            if (
              s.status === event.status &&
              s.activityAt === activityAt &&
              s.updatedAt === updatedAt
            ) {
              return s
            }
            return { ...s, status: event.status, activityAt, updatedAt }
          }),
        )
        break
      case "messages.replaced":
        setMessagesBySession((curr) => ({
          ...curr,
          [event.sessionId]: mergeReplacedMessages(
            curr[event.sessionId] ?? [],
            event.messages,
          ),
        }))
        break
      case "chat.message":
        setMessagesBySession((curr) => {
          const list = curr[event.message.sessionId] ?? []
          if (list.some((m) => m.id === event.message.id)) {
            return {
              ...curr,
              [event.message.sessionId]: list.map((m) =>
                m.id === event.message.id ? event.message : m,
              ),
            }
          }
          return {
            ...curr,
            [event.message.sessionId]: [...list, event.message],
          }
        })
        break
      case "chat.delta":
        setMessagesBySession((curr) => {
          const list = curr[event.sessionId] ?? []
          return {
            ...curr,
            [event.sessionId]: list.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    content: m.content + event.delta,
                    streaming: true,
                  }
                : m,
            ),
          }
        })
        break
      case "chat.item":
        setMessagesBySession((curr) => {
          const list = curr[event.sessionId] ?? []
          return {
            ...curr,
            [event.sessionId]: list.map((message) => {
              if (message.id !== event.messageId) return message
              const items = [...(message.items ?? [])]
              const index = items.findIndex((item) => item.id === event.item.id)
              if (index === -1) items.push(event.item)
              else items[index] = event.item
              return { ...message, items }
            }),
          }
        })
        break
      case "chat.done":
        setMessagesBySession((curr) => {
          const list = curr[event.sessionId] ?? []
          return {
            ...curr,
            [event.sessionId]: list.map((m) =>
              m.id === event.messageId ? { ...m, streaming: false } : m,
            ),
          }
        })
        break
      case "limits.changed":
        setLimitsBySession((curr) => ({
          ...curr,
          [event.sessionId]: event.limits,
        }))
        break
      case "usage.changed":
        setUsageBySession((curr) => ({
          ...curr,
          [event.sessionId]: event.total,
        }))
        if (event.messageId && event.turn) {
          const turn = event.turn
          const messageId = event.messageId
          setMessagesBySession((curr) => {
            const list = curr[event.sessionId] ?? []
            return {
              ...curr,
              [event.sessionId]: list.map((m) =>
                m.id === messageId ? { ...m, usage: turn } : m,
              ),
            }
          })
        }
        break
      case "permission.request":
        setPermissions((curr) =>
          curr.some((p) => p.requestId === event.request.requestId)
            ? curr
            : [...curr, event.request],
        )
        break
      case "permission.resolved":
        setPermissions((curr) =>
          curr.filter((p) => p.requestId !== event.requestId),
        )
        break
      case "input.request":
        setInputRequests((curr) =>
          curr.some((request) => request.requestId === event.request.requestId)
            ? curr
            : [...curr, event.request],
        )
        break
      case "input.resolved":
        setInputRequests((curr) =>
          curr.filter((request) => request.requestId !== event.requestId),
        )
        break
      case "session.ended": {
        if (event.reason === "killed") break
        const ended = event.reason === "error" ? "error" : "done"
        setSessions((curr) =>
          curr.map((s) =>
            s.id === event.id && s.status !== ended
              ? { ...s, status: ended }
              : s,
          ),
        )
        break
      }
      case "hook.ran":
        setHooksBySession((curr) => {
          const list = curr[event.run.sessionId] ?? []
          if (list.some((r) => r.id === event.run.id)) return curr
          return {
            ...curr,
            [event.run.sessionId]: [...list, event.run],
          }
        })
        break
      case "providers.statuses":
        setProviderStatuses(event.statuses)
        setProviders((curr) => applyStatusesToProviders(curr, event.statuses))
        break
      default:
        break
    }
  }, [])

  useEffect(() => {
    const unsub = window.chatHub.onHubEvent(applyEvent)
    const snapPromise = window.chatHub.getSnapshot()

    void (async () => {
      try {
        const [snap, pinned] = await Promise.all([
          snapPromise,
          window.chatHub.listProjects(),
        ])
        setSessions(snap.sessions)
        setMessagesBySession(snap.messages)
        setQueuedBySession(snap.queued)
        setUsageBySession(snap.usage)
        setLimitsBySession(snap.rateLimits)
        setPermissions(snap.permissions)
        setInputRequests(snap.inputRequests)
        // A restored layout already says which chat each pane holds; only a
        // pane left empty by it falls back to the session main remembers.
        const live = new Set(snap.sessions.map((s) => s.id))
        const pruned = pruneLayout(layoutRef.current, live)
        const restored =
          focusedPane(pruned).sessionId === null && snap.activeSessionId
            ? assignSession(pruned, pruned.focusedPaneId, snap.activeSessionId)
            : pruned
        setLayout(restored)
        activeIdRef.current = focusedPane(restored).sessionId
        // A session restored into a pane never goes through selectSession, and
        // would show no scroll-back without this.
        for (const restoredPane of restored.panes) {
          if (restoredPane.sessionId) {
            void seedOverflowFlag(restoredPane.sessionId)
          }
        }
        setProjects(pinned)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBooted(true)
      }
      try {
        const legacyArchived = readArchivedForMigration()
        if (legacyArchived.length > 0) {
          await window.chatHub.migrateArchived(legacyArchived)
        }
        clearMigratedArchive()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    void (async () => {
      try {
        const prov = await window.chatHub.listProviders()
        setProviders(prov)
        const settings = await window.chatHub.getSettings()
        setPermissionMode(settings.permissionMode)
        setProviderStatuses(settings.statuses)
        applyTheme(
          resolveTheme(settings.general.themeId, settings.general.customThemes),
        )
        if (settings.general.defaultEffort) {
          setEffort(settings.general.defaultEffort)
        }
        setModes(
          settings.general.modes?.length
            ? settings.general.modes
            : DEFAULT_MODES,
        )
        const enabled = new Set(
          settings.statuses
            .filter((s) => !s.isExtra && s.enabled)
            .map((s) => s.id),
        )
        const isOn = (id: ProviderId) => enabled.size === 0 || enabled.has(id)
        const saved = settings.general.defaultProvider
        const savedOk =
          saved && prov.find((p) => p.id === saved && p.available && isOn(saved))
        const firstAvailable =
          prov.find((p) => p.available && p.id !== "mock" && isOn(p.id)) ??
          prov.find((p) => p.available && isOn(p.id)) ??
          prov.find((p) => p.available && p.id !== "mock") ??
          prov.find((p) => p.available)
        if (savedOk) setProvider(saved)
        else if (firstAvailable) setProvider(firstAvailable.id)
        // First run: no onboarding done and nothing to show yet → wizard.
        const snap = await snapPromise
        if (!settings.general.onboarded && snap.sessions.length === 0) {
          setWizardOpen(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      unsub()
    }
  }, [applyEvent])

  useLayoutEffect(() => {
    if (!booted) return
    document.getElementById("boot-skeleton")?.remove()
  }, [booted])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    layoutRef.current = layout
    saveLayout(layout, windowId)
    // A workspace that is back to one pane keeps writing the dock preference,
    // so nothing about single-pane persistence changed — only its scope.
    const only = layout.panes.length === 1 ? layout.panes[0] : null
    if (only) saveDockOpen(only.dockOpen, windowId)
  }, [layout, windowId])

  // Main routes a notification or a Monitor click to the window already showing
  // that chat, which it can only do if each window says what it is holding.
  useEffect(() => {
    window.chatHub.reportWindowSessions(
      layout.panes
        .map((p) => p.sessionId)
        .filter((id): id is string => id !== null),
    )
  }, [layout])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    overflowRef.current = overflowHasMore
  }, [overflowHasMore])

  useEffect(() => {
    messagesBySessionRef.current = messagesBySession
  }, [messagesBySession])

  useEffect(() => {
    surfaceBySessionRef.current = surfaceBySession
  }, [surfaceBySession])

  useEffect(() => {
    autoOpenDockRef.current = autoOpenDock
  }, [autoOpenDock])

  /** The sessions on screen right now, left to right. */
  const paneSessions = useMemo(() => {
    const out: SessionMeta[] = []
    for (const item of layout.panes) {
      const found = item.sessionId
        ? sessions.find((s) => s.id === item.sessionId)
        : undefined
      if (found) out.push(found)
    }
    return out
  }, [layout.panes, sessions])

  // Effects below fan out over every open pane, so they key off a string
  // rather than an array whose identity changes on every render.
  const paneCwdKey = useMemo(
    () => JSON.stringify([...new Set(paneSessions.map((s) => s.cwd))]),
    [paneSessions],
  )

  useEffect(() => {
    let cancelled = false
    for (const cwd of JSON.parse(paneCwdKey) as string[]) {
      void window.chatHub.getGitInfo(cwd).then((info) => {
        if (!cancelled) setGitByCwd((curr) => ({ ...curr, [cwd]: info }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [paneCwdKey, gitRefresh])

  useEffect(() => {
    let cancelled = false
    for (const cwd of JSON.parse(paneCwdKey) as string[]) {
      void window.chatHub
        .scriptsList(cwd)
        .then((file) => {
          if (!cancelled) {
            setScriptsByCwd((curr) => ({ ...curr, [cwd]: file.scripts }))
          }
        })
        .catch(() => {
          if (!cancelled) setScriptsByCwd((curr) => ({ ...curr, [cwd]: [] }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [paneCwdKey])

  // A finished turn is exactly when the working copy changed under us, so the
  // source-control panel re-reads then instead of polling while an agent runs.
  const settledKey = useMemo(
    () =>
      paneSessions
        .filter((s) => s.status !== "running")
        .map((s) => s.id)
        .join("|"),
    [paneSessions],
  )
  useEffect(() => {
    setGitRefresh((n) => n + 1)
  }, [settledKey])

  const refreshGit = useCallback(() => setGitRefresh((n) => n + 1), [])

  const permissionsBySession = useMemo(() => {
    const out: Record<string, PermissionRequestInfo[]> = {}
    for (const request of permissions) {
      // A request whose agent id matched no session belongs to no pane.
      if (request.sessionId === null) continue
      ;(out[request.sessionId] ??= []).push(request)
    }
    return out
  }, [permissions])

  const inputRequestsBySession = useMemo(() => {
    const out: Record<string, AgentInputRequestInfo[]> = {}
    for (const request of inputRequests) {
      ;(out[request.sessionId] ??= []).push(request)
    }
    return out
  }, [inputRequests])

  const enabledProviderIds = useMemo<ProviderId[]>(() => {
    if (providerStatuses.length === 0) return providers.map((p) => p.id)
    // Provider pickers care about the base provider = its default instance.
    return providerStatuses
      .filter((s) => !s.isExtra && s.enabled)
      .map((s) => s.id)
  }, [providerStatuses, providers])

  const activeSurface = activeId ? (surfaceBySession[activeId] ?? null) : null

  useEffect(() => {
    if (sessions.length === 0) return
    const live = new Set(sessions.map((s) => s.id))
    prunePendingRuns(live)
    prunePendingPrompts(live)
    pruneDiffComments(live)
    prunePreviewPicks(live)
    pruneScriptTerminals(live)
    setLayout((curr) => pruneLayout(curr, live))
    setSurfaceBySession((curr) => {
      const next = Object.fromEntries(
        Object.entries(curr).filter(([id]) => live.has(id)),
      )
      if (Object.keys(next).length === Object.keys(curr).length) return curr
      saveSurfaceBySession(next)
      return next
    })
  }, [sessions])

  // Main answers "what is open?" from this mirror rather than asking a renderer
  // that may be mid-turn. With several panes it is the focused one that counts.
  useEffect(() => {
    window.chatHub.reportSurfaceState({
      activeSessionId: activeId,
      dockOpen: pane.dockOpen && activeId !== null,
      surfaceBySession,
    })
  }, [activeId, pane.dockOpen, surfaceBySession])

  const setDockFor = useCallback((paneId: string, open: boolean) => {
    setLayout((curr) => setPaneDock(curr, paneId, open))
  }, [])

  const toggleDockFor = useCallback((paneId: string) => {
    setLayout((curr) => {
      const target = curr.panes.find((p) => p.id === paneId)
      return target ? setPaneDock(curr, paneId, !target.dockOpen) : curr
    })
  }, [])

  const chooseSurface = useCallback(
    (paneId: string, sessionId: string, kind: SurfaceKind | null) => {
      setSurfaceBySession((curr) => {
        const next = { ...curr }
        if (kind === null) delete next[sessionId]
        else next[sessionId] = kind
        saveSurfaceBySession(next)
        return next
      })
      if (kind === "browser") setBrowserClaim(paneId)
      setLayout((curr) => focusPane(curr, paneId))
    },
    [],
  )

  const openSurface = useCallback(
    (paneId: string, sessionId: string, kind: SurfaceKind) => {
      chooseSurface(paneId, sessionId, kind)
      setDockFor(paneId, true)
    },
    [chooseSurface, setDockFor],
  )

  const claimBrowser = useCallback((paneId: string) => {
    setBrowserClaim(paneId)
  }, [])

  const toggleDiffSurface = useCallback(() => {
    if (!activeId) return
    if (pane.dockOpen && activeSurface === "diff") {
      setDockFor(pane.id, false)
      return
    }
    openSurface(pane.id, activeId, "diff")
  }, [activeId, pane.dockOpen, pane.id, activeSurface, openSurface, setDockFor])

  const toggleHistorySurface = useCallback(() => {
    if (!activeId) return
    if (pane.dockOpen && activeSurface === "history") {
      setDockFor(pane.id, false)
      return
    }
    openSurface(pane.id, activeId, "history")
  }, [activeId, pane.dockOpen, pane.id, activeSurface, openSurface, setDockFor])

  // A path clicked in a turn's changed-files row: open the Diff panel already
  // showing that file, rather than the working copy the reader has to hunt in.
  const openDiffForPath = useCallback(
    (paneId: string, sessionId: string, path: string) => {
      setDiffFocusBySession((curr) => ({
        ...curr,
        [sessionId]: { path, at: Date.now() },
      }))
      openSurface(paneId, sessionId, "diff")
    },
    [openSurface],
  )

  const openProjectFile = useCallback(
    (path: string, line?: number) => {
      const sessionId = activeIdRef.current
      if (!sessionId) return
      setFilesFocusBySession((curr) => ({
        ...curr,
        [sessionId]: {
          path,
          line: line ?? null,
          directory: false,
          at: Date.now(),
        },
      }))
      openSurface(layoutRef.current.focusedPaneId, sessionId, "files")
    },
    [openSurface],
  )

  useEffect(() => {
    return window.chatHub.onBrowserOpen((sessionId) => {
      setSurfaceBySession((curr) => {
        if (curr[sessionId] === "browser") return curr
        const next = { ...curr, [sessionId]: "browser" as const }
        saveSurfaceBySession(next)
        return next
      })
      const target = paneForSession(layoutRef.current, sessionId)
      if (!target) return
      setDockFor(target.id, true)
      setBrowserClaim(target.id)
    })
  }, [setDockFor])

  // An agent's dock tool. The surface is remembered for whichever session asked,
  // but only a session that is actually on screen may pull a panel open, focus a
  // file or start a script — a background turn must not rearrange what the user
  // is looking at, and must not run anything the user never saw start.
  useEffect(() => {
    return window.chatHub.onSurfaceOpen((request) => {
      const target = paneForSession(layoutRef.current, request.sessionId)
      if (request.surface === null) {
        if (target) setDockFor(target.id, false)
        return
      }
      const surface = request.surface
      setSurfaceBySession((curr) => {
        if (curr[request.sessionId] === surface) return curr
        const next = { ...curr, [request.sessionId]: surface }
        saveSurfaceBySession(next)
        return next
      })
      if (!target) return
      if (request.command) {
        stashTerminalCommand(request.sessionId, request.command)
      }
      if (request.path !== null && surface === "diff") {
        setDiffFocusBySession((curr) => ({
          ...curr,
          [request.sessionId]: { path: request.path as string, at: request.at },
        }))
        setGitRefresh((n) => n + 1)
      }
      if (request.path !== null && surface === "files") {
        setFilesFocusBySession((curr) => ({
          ...curr,
          [request.sessionId]: {
            path: request.path as string,
            line: request.line,
            directory: request.directory,
            at: request.at,
          },
        }))
      }
      if (surface === "browser") setBrowserClaim(target.id)
      setDockFor(target.id, true)
    })
  }, [setDockFor])

  /**
   * A turn that edited files wants this pane's dock on the diff. The pane asks;
   * the decision of whether that would yank the reader off something else is
   * still the surface store's.
   */
  const autoOpenDiff = useCallback(
    (paneId: string, sessionId: string, edited: string[]) => {
      const target = layoutRef.current.panes.find((p) => p.id === paneId)
      if (!target) return
      const decision = shouldAutoOpenDock(
        {
          showDock: target.dockOpen,
          activeSurface: surfaceBySessionRef.current[sessionId] ?? null,
        },
        edited,
        autoOpenDockRef.current,
      )
      if (!decision) return
      setSurfaceBySession((curr) => {
        const next = { ...curr, [sessionId]: decision }
        saveSurfaceBySession(next)
        return next
      })
      setDockFor(paneId, true)
      // The diff surface only refetches when its refreshKey bumps — if it was
      // already open and showing "diff"/"files", switching kind to the same
      // "diff" value doesn't remount SourceControl, so without this the panel
      // would keep showing a stale diff from before the edit.
      setGitRefresh((n) => n + 1)
    },
    [setDockFor],
  )

  function setSessionArchived(id: string, archive: boolean) {
    void window.chatHub
      .setSessionArchived(id, archive)
      .then((next) =>
        setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s))),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  function setSessionSettled(id: string, settled: boolean) {
    void window.chatHub
      .setSessionSettled(id, settled)
      .then((next) =>
        setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s))),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  function setSessionFavorite(id: string, favorite: boolean) {
    void window.chatHub
      .setSessionFavorite(id, favorite)
      .then((next) =>
        setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s))),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  // ProjectSearch unmounts with its session, and an unmounted overlay never
  // calls onClose — leaving anyOverlayOpen stuck true, which silently disables
  // the bare-Escape abort for the rest of the run.
  useEffect(() => {
    if (!activeSession) setProjectSearch(null)
  }, [activeSession])

  // Both widths are restored from a previous window that may have been wider,
  // and a resize can invalidate them at any time; the transcript floor is only
  // a floor if it is re-checked whenever the viewport moves.
  //
  // Fitting never persists. A clamp is what this window can show right now, the
  // stored number is what its owner chose — and the two part company constantly:
  // the viewport reads 0 while the window is hidden or still laying out, which
  // would otherwise save both columns at their minimum and lose the choice for
  // good. Only dragging a handle writes.
  useEffect(() => {
    const fit = () => {
      const viewport = window.innerWidth
      if (viewport < MIN_FIT_VIEWPORT) return
      const rail = sidebarCollapsed ? RAIL_WIDTH : sidebarWidth
      const dock = clampDockWidth(dockWidth, viewport, rail)
      if (dock !== dockWidth) setDockWidth(dock)
      const bar = clampSidebarWidth(
        sidebarWidth,
        viewport,
        pane.dockOpen && activeSession ? dock : 0,
      )
      if (bar !== sidebarWidth) setSidebarWidth(bar)
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [activeSession, pane.dockOpen, dockWidth, sidebarCollapsed, sidebarWidth])

  async function jumpToMessage(sessionId: string, messageId: string) {
    setHighlight({ sessionId, messageId })
    if (!paneForSession(layoutRef.current, sessionId)) {
      await selectSession(sessionId)
    }

    const loaded = messagesBySessionRef.current[sessionId] ?? []
    if (loaded.some((m) => m.id === messageId)) return

    // The hit came out of archive.jsonl, so nothing on screen can scroll to it
    // until the pages between here and there are pulled in.
    loadingOlderRef.current = sessionId
    setLoadingOlderFor(sessionId)
    try {
      const page = await window.chatHub.loadArchiveThrough(
        sessionId,
        loaded[0]?.id ?? null,
        messageId,
      )
      if (page.messages.length > 0) {
        setMessagesBySession((curr) => {
          const existing = curr[sessionId] ?? []
          const seen = new Set(existing.map((m) => m.id))
          const older = page.messages.filter((m) => !seen.has(m.id))
          return { ...curr, [sessionId]: [...older, ...existing] }
        })
        setOverflowHasMore((curr) => ({ ...curr, [sessionId]: page.hasMore }))
      }
      if (!page.reachedTarget) {
        setHighlight(null)
        setError(
          "That match sits further back than one jump can load — keep scrolling up in the transcript to reach it.",
        )
      }
    } catch (err) {
      setHighlight(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      loadingOlderRef.current = null
      setLoadingOlderFor(null)
    }
  }

  const clearHighlight = useCallback(() => setHighlight(null), [])

  async function resolvePermission(requestId: string, allow: boolean) {
    // Optimistic: main echoes permission.resolved, but the island may have
    // answered first — in which case the card is already gone either way.
    setPermissions((curr) => curr.filter((p) => p.requestId !== requestId))
    try {
      await window.chatHub.resolvePermission(requestId, allow)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPermissions(await window.chatHub.listPermissions())
    }
  }

  async function resolveAgentInput(
    requestId: string,
    answers: Record<string, string[]>,
  ) {
    setInputRequests((curr) => curr.filter((request) => request.requestId !== requestId))
    try {
      await window.chatHub.resolveInput(requestId, answers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const snap = await window.chatHub.getSnapshot()
      setInputRequests(snap.inputRequests)
    }
  }

  function openNewSession(hint?: {
    project?: string
    cwd?: string
    paneId?: string
  }) {
    const projectHint = hint?.project
    let cwd = hint?.cwd
    const known = sessionsRef.current
    const current = known.find((s) => s.id === activeIdRef.current) ?? null
    if (!cwd && projectHint && current?.project === projectHint) {
      cwd = current.cwd
    } else if (!cwd && projectHint) {
      cwd = known.find((s) => s.project === projectHint)?.cwd
    }
    setNewSessionHint({ project: projectHint, cwd, paneId: hint?.paneId })
    setNewSessionOpen(true)
  }

  /** A pane opened for a chat that never happened has nothing left to show. */
  function closeNewSession() {
    setNewSessionOpen(false)
    const paneId = newSessionHint.paneId
    if (!paneId) return
    setLayout((curr) => {
      const target = curr.panes.find((p) => p.id === paneId)
      return target && target.sessionId === null ? closePane(curr, paneId) : curr
    })
  }

  async function addProject() {
    setError(null)
    try {
      const res = await window.chatHub.addProject()
      if (res) setProjects(res.projects)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function renameProject(id: string, currentName: string) {
    const next = window.prompt("Rename project", currentName)
    if (!next?.trim() || next.trim() === currentName) return
    try {
      setProjects(await window.chatHub.renameProject(id, next.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeProject(id: string, name: string) {
    if (!window.confirm(`Remove project "${name}" from the sidebar?`)) return
    try {
      setProjects(await window.chatHub.removeProject(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function createSessionFromDraft(draft: NewSessionDraft) {
    setError(null)
    setBusy(true)
    const intoPane = newSessionHint.paneId ?? layoutRef.current.focusedPaneId
    try {
      if (draft.permissionMode !== permissionMode) {
        await window.chatHub.setPermissionMode(draft.permissionMode)
        setPermissionMode(draft.permissionMode)
      }
      setProvider(draft.provider)
      const session = await window.chatHub.createSession({
        provider: draft.provider,
        instanceId: draft.instanceId,
        cwd: draft.cwd,
        project: projectFromCwd(draft.cwd),
        model: draft.model,
        title: draft.title,
        worktree: draft.worktree,
      })
      setLayout((curr) => assignSession(curr, intoPane, session.id))
      activeIdRef.current = session.id
      setSessions((curr) => {
        if (curr.some((s) => s.id === session.id)) return curr
        return [session, ...curr]
      })
      setMessagesBySession((curr) => ({ ...curr, [session.id]: [] }))
      // The folder is auto-pinned as a project in main — reflect it.
      void window.chatHub.listProjects().then(setProjects)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function seedOverflowFlag(id: string) {
    try {
      const hasOverflow = await window.chatHub.hasArchivedMessages(id)
      setOverflowHasMore((curr) => ({ ...curr, [id]: hasOverflow }))
    } catch {
      // A missing archive is not an error worth a banner — the scroll-back
      // affordance simply stays hidden.
    }
  }

  /** Fetch what a session needs to be shown, wherever it just landed. */
  async function adoptSession(id: string) {
    activeIdRef.current = id
    setError(null)
    try {
      await window.chatHub.setActiveSession(id)
      if (!messagesBySessionRef.current[id]) {
        const msgs = await window.chatHub.getMessages(id)
        setMessagesBySession((curr) => ({ ...curr, [id]: msgs }))
      }
      await seedOverflowFlag(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function selectSession(id: string) {
    // Kept in step synchronously: main echoes session.active back at us, and a
    // ref that is one render stale would bounce the selection forever.
    setLayout((curr) => assignSession(curr, curr.focusedPaneId, id))
    await adoptSession(id)
  }

  /**
   * Another window on the same sessions. The chat is left where it is — a
   * session can sit in a pane of two different windows at once, and moving it
   * out from under this one is not what "open in new window" offers.
   */
  const openInNewWindow = useCallback((sessionId?: string) => {
    void window.chatHub.openWindow(sessionId)
  }, [])

  async function loadOlderMessages(sessionId: string) {
    if (loadingOlderRef.current !== null) return
    if (overflowRef.current[sessionId] === false) return
    const list = messagesBySessionRef.current[sessionId] ?? []
    const beforeId = list[0]?.id ?? null
    loadingOlderRef.current = sessionId
    setLoadingOlderFor(sessionId)
    try {
      const page = await window.chatHub.loadArchivedMessages(
        sessionId,
        beforeId,
        50,
      )
      if (page.messages.length > 0) {
        setMessagesBySession((curr) => {
          const existing = curr[sessionId] ?? []
          const seen = new Set(existing.map((m) => m.id))
          const older = page.messages.filter((m) => !seen.has(m.id))
          return { ...curr, [sessionId]: [...older, ...existing] }
        })
      }
      setOverflowHasMore((curr) => ({
        ...curr,
        [sessionId]: page.hasArchive && page.hasMore,
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      loadingOlderRef.current = null
      setLoadingOlderFor(null)
    }
  }

  useEffect(() => {
    selectSessionRef.current = (id: string) => void selectSession(id)
  })

  async function deleteSession(id: string) {
    const title = sessions.find((s) => s.id === id)?.title ?? id
    // Delete drops the transcript from memory and state.json — no archive, no
    // undo — and the × sits under the cursor right after a row click.
    if (
      !window.confirm(`Delete session "${title}" and its transcript? No undo.`)
    ) {
      return
    }
    setError(null)
    try {
      await window.chatHub.deleteSession(id)
      const snap = await window.chatHub.getSnapshot()
      setSessions(snap.sessions)
      setMessagesBySession(snap.messages)
      setQueuedBySession(snap.queued)
      setUsageBySession(snap.usage)
      setLimitsBySession(snap.rateLimits)
      setPermissions(snap.permissions)
      setInputRequests(snap.inputRequests)
      const live = new Set(snap.sessions.map((s) => s.id))
      setLayout((curr) => {
        const pruned = pruneLayout(curr, live)
        return focusedPane(pruned).sessionId === null && snap.activeSessionId
          ? assignSession(pruned, pruned.focusedPaneId, snap.activeSessionId)
          : pruned
      })
      activeIdRef.current = snap.activeSessionId
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sendMessage = useCallback(
    async (
      sessionId: string,
      text: string,
      opts?: { effort?: EffortLevel; attachments?: string[] },
    ) => {
      setError(null)
      setSendingIds((curr) => new Set(curr).add(sessionId))
      try {
        // Always straight through: main owns the queue, so a follow-up typed
        // mid-turn lands in the transcript and is flushed when the turn ends —
        // queueing here too would leave the notch island's replies invisible.
        await window.chatHub.sendMessage(sessionId, text, {
          effort: opts?.effort ?? effort,
          attachments: opts?.attachments,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        // Rethrown so the composer can hand the typed prompt back.
        throw err
      } finally {
        setSendingIds((curr) => {
          const next = new Set(curr)
          next.delete(sessionId)
          return next
        })
      }
    },
    [effort],
  )

  const cancelQueued = useCallback((sessionId: string, queuedId: string) => {
    void window.chatHub
      .cancelQueued(sessionId, queuedId)
      .then((queued) =>
        setQueuedBySession((curr) => ({ ...curr, [sessionId]: queued })),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const renameSession = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId)
    if (!session) return
    const next = window.prompt("Rename session", session.title)
    if (!next?.trim()) return
    void window.chatHub
      .renameSession(session.id, next.trim())
      .then((s) => setSessions((curr) => curr.map((x) => (x.id === s.id ? s : x))))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const changeEffort = useCallback((next: EffortLevel) => {
    setEffort(next)
    void window.chatHub.setGeneralConfig({ defaultEffort: next }).catch(() => {})
  }, [])

  /** Settings edits the default for sessions that have no override of their own. */
  async function changeGlobalPermission(mode: PermissionMode) {
    setPermissionMode(mode)
    try {
      const next = await window.chatHub.setPermissionMode(mode)
      setPermissionMode(next.permissionMode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const changePermission = useCallback(
    (sessionId: string, mode: PermissionMode) => {
      void window.chatHub.setSessionPermission(sessionId, mode).catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    },
    [],
  )

  const abortSession = useCallback((sessionId: string) => {
    void window.chatHub.abortSession(sessionId).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const changeModel = useCallback((sessionId: string, model: string) => {
    void window.chatHub
      .setSessionModel(sessionId, model)
      .then((next) =>
        setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s))),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const applyMode = useCallback(
    (sessionId: string, modeId: string) => {
      // Empty id = "No mode": clears the preset but leaves model/permission alone.
      const mode = modeId ? modes.find((m) => m.id === modeId) : undefined
      void window.chatHub
        .applySessionMode(sessionId, {
          modeId: mode?.id,
          systemPrompt: mode?.systemPrompt,
          model: mode?.model,
          permissionMode: mode?.permissionMode,
        })
        .then((next) => {
          setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s)))
          // Effort is composer state, not a session field — set it here so the
          // mode's effort actually takes hold on the next turn.
          if (mode?.effort) setEffort(mode.effort)
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
        })
    },
    [modes],
  )

  const openFolder = useCallback((cwd: string) => {
    void window.chatHub.openPath(cwd).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const openEditor = useCallback((cwd: string) => {
    void window.chatHub.openInEditor(cwd).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const saveScripts = useCallback(
    async (cwd: string, next: ProjectScript[]) => {
      const saved = await window.chatHub.scriptsSave(cwd, next)
      setScriptsByCwd((curr) => ({ ...curr, [cwd]: saved.scripts }))
    },
    [],
  )

  const runScript = useCallback(
    (paneId: string, sessionId: string, script: ProjectScript) => {
      stashTerminalCommand(sessionId, script.command)
      openSurface(paneId, sessionId, "terminal")
      if (script.autoOpenPreview && script.previewUrl) {
        const url = script.previewUrl
        window.setTimeout(() => {
          const still = layoutRef.current.panes.find((p) => p.id === paneId)
          if (still?.sessionId !== sessionId) return
          stashBrowserUrl(sessionId, url)
          openSurface(paneId, sessionId, "browser")
        }, SCRIPT_PREVIEW_SWITCH_MS)
      }
    },
    [openSurface],
  )

  const focusPaneById = useCallback((paneId: string) => {
    setLayout((curr) => focusPane(curr, paneId))
  }, [])

  const closePaneById = useCallback((paneId: string) => {
    setLayout((curr) => closePane(curr, paneId))
  }, [])

  /** Everything a pane can ask for, bundled so panes stay memoized. */
  const paneActions = useMemo<PaneActions>(
    () => ({
      onFocusPane: focusPaneById,
      onClosePane: closePaneById,
      onToggleDock: toggleDockFor,
      onSelectSurface: chooseSurface,
      onClaimBrowser: claimBrowser,
      onAutoOpenDiff: autoOpenDiff,
      // Through the ref: this object is memoized, and a direct call would pin
      // the first render's closure.
      onSelectSession: (id) => selectSessionRef.current(id),
      onSend: sendMessage,
      onAbort: abortSession,
      onCancelQueued: cancelQueued,
      onRenameSession: renameSession,
      onUnsettle: (id) => setSessionSettled(id, false),
      onModelChange: changeModel,
      onApplyMode: applyMode,
      onPermissionChange: changePermission,
      onEffortChange: changeEffort,
      onOpenFolder: openFolder,
      onOpenEditor: openEditor,
      onLoadOlder: (id) => void loadOlderMessages(id),
      onHighlightShown: clearHighlight,
      onResolvePermission: (id, allow) => void resolvePermission(id, allow),
      onResolveInput: (id, answers) => void resolveAgentInput(id, answers),
      onRunScript: runScript,
      onSaveScripts: saveScripts,
      onOpenDiff: openDiffForPath,
      onCreate: () => openNewSession(),
      onShowShortcuts: () => setShortcutsOpen(true),
      onGitChanged: refreshGit,
      onDockWidthChange: setDockWidth,
      onDockWidthCommit: saveDockWidth,
      onPaneDragStart: (paneId, event) => {
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData(PANE_MIME, paneId)
      },
      onPaneDragEnd: () => undefined,
    }),
    // Only the handlers that close over changing state re-bind; the rest are
    // stable, which is what lets an idle pane skip a re-render.
    [
      abortSession,
      applyMode,
      autoOpenDiff,
      cancelQueued,
      changeEffort,
      changeModel,
      changePermission,
      chooseSurface,
      claimBrowser,
      clearHighlight,
      closePaneById,
      focusPaneById,
      openDiffForPath,
      openEditor,
      openFolder,
      refreshGit,
      renameSession,
      runScript,
      saveScripts,
      sendMessage,
      toggleDockFor,
    ],
  )

  function onWorkspaceDrop(drop: WorkspaceDrop) {
    if (drop.kind === "pane") {
      const target = drop.target
      if (target.kind !== "insert") return
      setLayout((curr) =>
        isNoopMove(curr, drop.paneId, target.index)
          ? curr
          : movePane(curr, drop.paneId, target.index),
      )
      return
    }
    if (drop.kind === "session") {
      const target = drop.target
      const sessionId = drop.sessionId
      setLayout((curr) =>
        target.kind === "into"
          ? assignSession(curr, target.paneId, sessionId)
          : openPaneAt(curr, sessionId, target.index, nextPaneId(curr)),
      )
      void adoptSession(sessionId)
      return
    }
    // A project has no chat yet: make the pane the drop asked for and let the
    // dialog fill it. Cancelling takes the empty pane away again.
    const target: DropTarget = drop.target
    if (target.kind === "into") {
      setLayout((curr) => focusPane(curr, target.paneId))
      openNewSession({ project: drop.project.name, cwd: drop.project.cwd })
      return
    }
    const paneId = nextPaneId(layoutRef.current)
    setLayout((curr) => openPaneAt(curr, null, target.index, paneId))
    openNewSession({
      project: drop.project.name,
      cwd: drop.project.cwd,
      paneId,
    })
  }

  const anyOverlayOpen =
    settingsOpen ||
    wizardOpen ||
    newSessionOpen ||
    paletteOpen ||
    shortcutsOpen ||
    projectSearch !== null

  useEffect(() => {
    // Re-registered whenever the state it reads changes, so a binding never
    // fires against a stale session or an overlay that has since closed.
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      // Also an app-menu item, which is what catches it while a native control
      // has the key events — this copy answers with an overlay open.
      if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault()
        openInNewWindow()
        return
      }
      if (meta && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault()
        openNewSession()
        return
      }
      if (!meta && e.altKey && e.shiftKey && e.code === "KeyU") {
        if (anyOverlayOpen || isEditableTarget(e.target)) return
        e.preventDefault()
        attention.jumpNext()
        return
      }
      // Pane walk. Every other binding below resolves against the focused
      // pane, so this is the one that decides which chat they all mean.
      if (meta && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault()
        const delta = e.key === "ArrowLeft" ? -1 : 1
        setLayout((curr) =>
          e.shiftKey
            ? movePane(
                curr,
                curr.focusedPaneId,
                curr.panes.findIndex((p) => p.id === curr.focusedPaneId) +
                  (delta === 1 ? 2 : -1),
              )
            : stepFocus(curr, delta),
        )
        return
      }
      if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault()
        if (activeSession) {
          setProjectSearch((m) => (m === "files" ? null : "files"))
        }
        return
      }
      if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault()
        if (activeSession) {
          setProjectSearch((m) => (m === "content" ? null : "content"))
        }
        return
      }
      if (meta && e.key === "/") {
        e.preventDefault()
        setShortcutsOpen((o) => !o)
        return
      }
      if (meta && e.key.toLowerCase() === "g") {
        e.preventDefault()
        if (activeSession) toggleDiffSurface()
        return
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault()
        if (activeSession) toggleHistorySurface()
        return
      }
      if (meta && e.key.toLowerCase() === "b") {
        e.preventDefault()
        if (activeSession) toggleDockFor(pane.id)
        return
      }
      if (meta && e.altKey && e.code.startsWith("Digit")) {
        const script = (
          activeSession ? (scriptsByCwd[activeSession.cwd] ?? []) : []
        ).find((s) => s.hotkey === e.code.slice(5))
        if (script && activeSession) {
          e.preventDefault()
          runScript(pane.id, activeSession.id, script)
        }
        return
      }
      // Overlays own their own Escape; only a bare Escape stops the agent.
      if (e.key === "Escape" && !anyOverlayOpen) {
        if (activeSession?.status === "running") {
          e.preventDefault()
          abortSession(activeSession.id)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    anyOverlayOpen,
    activeSession,
    activeSession?.id,
    activeSession?.status,
    attention,
    pane.id,
    scriptsByCwd,
    runScript,
    abortSession,
    openInNewWindow,
    toggleDockFor,
    toggleDiffSurface,
    toggleHistorySurface,
  ])

  // Only the agent this Hub is set to use — a CLI the user installed but never
  // signed into is not a problem worth a banner on every launch.
  const needsAuth = providerStatuses.some(
    (s) =>
      s.id === provider && !s.isExtra && s.installed && s.auth === "needs_login",
  )
  const noneInstalled =
    providerStatuses.length > 0 &&
    providerStatuses
      .filter((s) => s.id !== "mock")
      .every((s) => !s.installed)

  const showOnboard =
    !onboardDismissed && (noneInstalled || needsAuth) && !settingsOpen

  const onboard = useMemo(
    () =>
      showOnboard
        ? {
            text: noneInstalled
              ? "No agent CLIs found on PATH."
              : "Some agents need login.",
            onOpenSettings: () => setSettingsOpen(true),
            onDismiss: () => {
              setOnboardDismissed(true)
              localStorage.setItem(AUTH_NAG_KEY, "1")
            },
          }
        : null,
    [showOnboard, noneInstalled],
  )

  const tiled = layout.panes.length > 1
  const showDock = pane.dockOpen && activeSession !== null

  if (!booted) {
    return (
      <div
        className={`app ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
      />
    )
  }

  return (
    <div
      className={`app ${sidebarCollapsed ? "sidebar-is-collapsed" : ""} ${
        tiled ? "is-tiled" : showDock ? "dock-is-open" : ""
      }`}
      style={
        {
          "--sidebar-w": `${sidebarWidth}px`,
          "--dock-w": `${dockWidth}px`,
        } as CSSProperties
      }
    >
      <Sidebar
        sessions={sessions}
        messagesBySession={messagesBySession}
        projects={projects}
        activeId={activeId}
        attentionSeen={attention.seen}
        needsYou={attention.queue}
        busy={busy}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        dockWidth={showDock ? dockWidth : 0}
        onWidthChange={setSidebarWidth}
        onWidthCommit={saveSidebarWidth}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        onCreate={(hint) => openNewSession(hint)}
        onSelect={(id) => void selectSession(id)}
        onArchive={setSessionArchived}
        onSettle={setSessionSettled}
        onFavorite={setSessionFavorite}
        onJumpToMessage={(sessionId, messageId) =>
          void jumpToMessage(sessionId, messageId)
        }
        onDelete={(id) => void deleteSession(id)}
        onOpenInNewWindow={openInNewWindow}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSwitcher={() => setPaletteOpen(true)}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onAddProject={() => void addProject()}
        onRenameProject={(id, name) => void renameProject(id, name)}
        onRemoveProject={(id, name) => void removeProject(id, name)}
        onOpenProject={(cwd) => {
          void window.chatHub.openPath(cwd).catch((err) => {
            setError(err instanceof Error ? err.message : String(err))
          })
        }}
      />
      <Workspace
        layout={layout}
        sessions={sessions}
        messagesBySession={messagesBySession}
        usageBySession={usageBySession}
        limitsBySession={limitsBySession}
        queuedBySession={queuedBySession}
        hooksBySession={hooksBySession}
        permissionsBySession={permissionsBySession}
        inputRequestsBySession={inputRequestsBySession}
        surfaceBySession={surfaceBySession}
        diffFocusBySession={diffFocusBySession}
        filesFocusBySession={filesFocusBySession}
        gitByCwd={gitByCwd}
        scriptsByCwd={scriptsByCwd}
        overflowHasMore={overflowHasMore}
        loadingOlderFor={loadingOlderFor}
        sendingIds={sendingIds}
        highlight={highlight}
        providers={providers}
        providerStatuses={providerStatuses}
        fallbackProvider={provider}
        modes={modes}
        effort={effort}
        permissionMode={permissionMode}
        dockWidth={dockWidth}
        sidebarWidth={sidebarCollapsed ? RAIL_WIDTH : sidebarWidth}
        gitRefresh={gitRefresh}
        error={error}
        onboard={onboard}
        anyOverlayOpen={anyOverlayOpen}
        browserClaim={browserClaim}
        actions={paneActions}
        onDrop={onWorkspaceDrop}
      />
      {settingsOpen ? (
        <SettingsModal
          open={settingsOpen}
          onClose={() => {
            setSettingsOpen(false)
            void window.chatHub.getSettings().then((s) => {
              setProviderStatuses(s.statuses)
              setPermissionMode(s.permissionMode)
              applyTheme(resolveTheme(s.general.themeId, s.general.customThemes))
              if (s.general.defaultEffort) setEffort(s.general.defaultEffort)
              if (
                s.general.defaultProvider &&
                s.statuses.find(
                  (st) => st.id === s.general.defaultProvider && st.enabled,
                )
              ) {
                setProvider(s.general.defaultProvider)
              }
            })
          }}
          permissionMode={permissionMode}
          onPermissionChange={(m) => void changeGlobalPermission(m)}
          autoOpenDock={autoOpenDock}
          onAutoOpenDockChange={(enabled) => {
            setAutoOpenDock(enabled)
            saveAutoOpenDock(enabled)
          }}
          projectCwd={
            activeSession?.cwd ?? projects[0]?.cwd ?? null
          }
          sessions={sessions}
        />
      ) : null}
      {wizardOpen ? (
        <FirstRunWizard
          onFinish={() => {
            setWizardOpen(false)
            void Promise.all([
              window.chatHub.getSnapshot(),
              window.chatHub.getSettings(),
              window.chatHub.listProjects(),
            ]).then(([snap, s, pinned]) => {
              setSessions(snap.sessions)
              setMessagesBySession(snap.messages)
              setQueuedBySession(snap.queued)
              setUsageBySession(snap.usage)
              setLimitsBySession(snap.rateLimits)
              setPermissions(snap.permissions)
              setInputRequests(snap.inputRequests)
              if (snap.activeSessionId) {
                const id = snap.activeSessionId
                setLayout((curr) =>
                  assignSession(curr, curr.focusedPaneId, id),
                )
              }
              setProjects(pinned)
              setProviderStatuses(s.statuses)
              if (s.general.defaultProvider) setProvider(s.general.defaultProvider)
            })
          }}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          sessions={sessions}
          activeId={activeId}
          attentionCount={attention.queue.length}
          onSelect={(id) => void selectSession(id)}
          onNextAttention={attention.jumpNext}
          onNewWindow={openInNewWindow}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {projectSearch && activeSession ? (
        <ProjectSearch
          cwd={activeSession.cwd}
          mode={projectSearch}
          onModeChange={setProjectSearch}
          onOpenFile={openProjectFile}
          onClose={() => setProjectSearch(null)}
        />
      ) : null}
      {shortcutsOpen ? (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      ) : null}
      <NewSessionDialog
        open={newSessionOpen}
        providers={providers}
        enabledProviderIds={enabledProviderIds}
        statuses={providerStatuses}
        initialProvider={provider}
        projectHint={newSessionHint.project}
        hintCwd={newSessionHint.cwd}
        onClose={closeNewSession}
        onCreate={createSessionFromDraft}
      />
    </div>
  )
}
