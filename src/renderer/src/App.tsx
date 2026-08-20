import {
  useCallback,
  useEffect,
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
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import { collectAgentActions, editedPathsInMessage } from "./lib/agent-actions"
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
import { Sidebar } from "./components/Sidebar"
import { ChatView } from "./components/ChatView"
import { SurfaceDock } from "./components/surfaces/SurfaceDock"
import type { SurfaceKind } from "./lib/surface-bridge"
import {
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
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({})
  /** Transcript overflow: more pages available in archive.jsonl for this id. */
  const [overflowHasMore, setOverflowHasMore] = useState<
    Record<string, boolean>
  >({})
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadingOlderRef = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
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
  }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [git, setGit] = useState<GitCheckoutInfo | null>(null)
  const [dockOpen, setDockOpen] = useState(loadDockOpen)
  const [dockWidth, setDockWidth] = useState(loadDockWidth)
  const [surfaceBySession, setSurfaceBySession] = useState<
    Record<string, SurfaceKind>
  >(loadSurfaceBySession)
  const [autoOpenDock, setAutoOpenDock] = useState(loadAutoOpenDock)
  const [gitRefresh, setGitRefresh] = useState(0)
  // `at` re-fires the focus even when the same path is clicked twice.
  const [diffFocus, setDiffFocus] = useState<{
    path: string
    at: number
  } | null>(null)
  const [filesFocus, setFilesFocus] = useState<{
    path: string
    line: number | null
    at: number
  } | null>(null)
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
  const [permissions, setPermissions] = useState<PermissionRequestInfo[]>([])
  const [inputRequests, setInputRequests] = useState<AgentInputRequestInfo[]>([])
  /** Project hooks that have run, keyed by session id (oldest first). */
  const [hooksBySession, setHooksBySession] = useState<
    Record<string, HookRun[]>
  >({})
  const [scripts, setScripts] = useState<ProjectScript[]>([])
  const [highlight, setHighlight] = useState<{
    sessionId: string
    messageId: string
  } | null>(null)

  const activeIdRef = useRef<string | null>(null)
  const selectSessionRef = useRef<(id: string) => void>(() => {})
  // Read after an await, where the value this render closed over is already old.
  const messagesBySessionRef = useRef(messagesBySession)
  // applyEvent below is a stable (empty-deps) callback bridging main-process
  // events into state; it needs the latest dock/surface/pref values without
  // taking them as deps (which would re-subscribe the IPC listener on every
  // toggle), so they ride in refs kept fresh by the effects further down.
  const dockOpenRef = useRef(dockOpen)
  const surfaceBySessionRef = useRef(surfaceBySession)
  const autoOpenDockRef = useRef(autoOpenDock)
  const autoOpenSeenRef = useRef<{ messageId: string; count: number }>({
    messageId: "",
    count: 0,
  })

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
        } else {
          setActiveId(event.sessionId)
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
          curr.map((s) =>
            s.id === event.id
              ? { ...s, status: event.status, updatedAt: Date.now() }
              : s,
          ),
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
      case "session.ended":
        setSessions((curr) =>
          curr.map((s) =>
            s.id === event.id && event.reason === "killed"
              ? s
              : s.id === event.id
                ? {
                    ...s,
                    status: event.reason === "error" ? "error" : "done",
                    updatedAt: Date.now(),
                  }
                : s,
          ),
        )
        break
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
      default:
        break
    }
  }, [])

  useEffect(() => {
    let unsub = () => {}
    void (async () => {
      try {
        const [snap, prov, settings, pinned] = await Promise.all([
          window.chatHub.getSnapshot(),
          window.chatHub.listProviders(),
          window.chatHub.getSettings(),
          window.chatHub.listProjects(),
        ])
        setSessions(snap.sessions)
        setMessagesBySession(snap.messages)
        setQueuedBySession(snap.queued)
        setUsageBySession(snap.usage)
        setPermissions(snap.permissions)
        setInputRequests(snap.inputRequests)
        setActiveId(snap.activeSessionId)
        // A session restored as the active one never goes through
        // selectSession, and would show no scroll-back without this.
        if (snap.activeSessionId) {
          void seedOverflowFlag(snap.activeSessionId)
        }
        setProjects(pinned)
        setProviders(prov)
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
        if (!settings.general.onboarded && snap.sessions.length === 0) {
          setWizardOpen(true)
        }
        const legacyArchived = readArchivedForMigration()
        if (legacyArchived.length > 0) {
          await window.chatHub.migrateArchived(legacyArchived)
        }
        clearMigratedArchive()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    unsub = window.chatHub.onHubEvent(applyEvent)

    return () => {
      unsub()
    }
  }, [applyEvent])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    messagesBySessionRef.current = messagesBySession
  }, [messagesBySession])

  useEffect(() => {
    dockOpenRef.current = dockOpen
  }, [dockOpen])

  useEffect(() => {
    surfaceBySessionRef.current = surfaceBySession
  }, [surfaceBySession])

  useEffect(() => {
    autoOpenDockRef.current = autoOpenDock
  }, [autoOpenDock])

  const messages = activeId ? (messagesBySession[activeId] ?? []) : []
  // Diff surface audit trail: same tool cards the transcript already parsed.
  const agentActions = useMemo(() => collectAgentActions(messages), [messages])

  // Auto-open the diff dock off the same parse the transcript draws, so there
  // is one answer to "what did this turn change" rather than two. Only the
  // session in view may steal the dock, and only while its turn is still
  // streaming — a transcript restored from disk must not yank the panel open.
  useEffect(() => {
    const sessionId = activeId
    if (!sessionId) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant" || !last.streaming) return
    const edited = editedPathsInMessage(last)
    const seen = autoOpenSeenRef.current
    const known = seen.messageId === last.id ? seen.count : 0
    if (edited.length <= known) return
    autoOpenSeenRef.current = { messageId: last.id, count: edited.length }
    const decision = shouldAutoOpenDock(
      {
        showDock: dockOpenRef.current,
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
    setDockOpen(true)
    saveDockOpen(true)
    // The diff surface only refetches when its refreshKey bumps — if it was
    // already open and showing "diff"/"files", switching kind to the same
    // "diff" value doesn't remount SourceControl, so without this the panel
    // would keep showing a stale diff from before the edit.
    setGitRefresh((n) => n + 1)
  }, [activeId, messages])

  useEffect(() => {
    return window.chatHub.onBrowserOpen((sessionId) => {
      setSurfaceBySession((curr) => {
        if (curr[sessionId] === "browser") return curr
        const next = { ...curr, [sessionId]: "browser" as const }
        saveSurfaceBySession(next)
        return next
      })
      setDockOpen(true)
      saveDockOpen(true)
    })
  }, [])

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

  async function jumpToMessage(sessionId: string, messageId: string) {
    setHighlight({ sessionId, messageId })
    if (sessionId !== activeIdRef.current) await selectSession(sessionId)

    const loaded = messagesBySessionRef.current[sessionId] ?? []
    if (loaded.some((m) => m.id === messageId)) return

    // The hit came out of archive.jsonl, so nothing on screen can scroll to it
    // until the pages between here and there are pulled in.
    loadingOlderRef.current = true
    setLoadingOlder(true)
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
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }

  const clearHighlight = useCallback(() => setHighlight(null), [])

  const sessionModels = useMemo(() => {
    if (activeSession) {
      const wantInstance = activeSession.instanceId ?? activeSession.provider
      const byInst = providerStatuses.find((s) => s.instanceId === wantInstance)
      if (byInst) return byInst.models
    }
    const id = activeSession?.provider ?? provider
    return providerStatuses.find((s) => s.id === id && !s.isExtra)?.models ?? []
  }, [activeSession, provider, providerStatuses])

  const enabledProviderIds = useMemo<ProviderId[]>(() => {
    if (providerStatuses.length === 0) return providers.map((p) => p.id)
    // Provider pickers care about the base provider = its default instance.
    return providerStatuses
      .filter((s) => !s.isExtra && s.enabled)
      .map((s) => s.id)
  }, [providerStatuses, providers])

  useEffect(() => {
    if (!activeSession?.cwd) {
      setGit(null)
      return
    }
    let cancelled = false
    void window.chatHub.getGitInfo(activeSession.cwd).then((info) => {
      if (!cancelled) setGit(info)
    })
    return () => {
      cancelled = true
    }
  }, [activeSession?.id, activeSession?.cwd, activeSession?.status, gitRefresh])

  useEffect(() => {
    // A finished turn is exactly when the working copy changed under us, so the
    // source-control panel re-reads then instead of polling while the agent runs.
    if (activeSession && activeSession.status !== "running") {
      setGitRefresh((n) => n + 1)
    }
  }, [activeSession?.id, activeSession?.status])

  const refreshGit = useCallback(() => setGitRefresh((n) => n + 1), [])

  const activeSurface = activeId ? (surfaceBySession[activeId] ?? null) : null

  useEffect(() => {
    if (sessions.length === 0) return
    const live = new Set(sessions.map((s) => s.id))
    prunePendingRuns(live)
    prunePendingPrompts(live)
    pruneDiffComments(live)
    prunePreviewPicks(live)
    pruneScriptTerminals(live)
    setSurfaceBySession((curr) => {
      const next = Object.fromEntries(
        Object.entries(curr).filter(([id]) => live.has(id)),
      )
      if (Object.keys(next).length === Object.keys(curr).length) return curr
      saveSurfaceBySession(next)
      return next
    })
  }, [sessions])

  const setDock = useCallback((open: boolean) => {
    setDockOpen(open)
    saveDockOpen(open)
  }, [])

  const chooseSurface = useCallback(
    (kind: SurfaceKind | null) => {
      if (!activeId) return
      setSurfaceBySession((curr) => {
        const next = { ...curr }
        if (kind === null) delete next[activeId]
        else next[activeId] = kind
        saveSurfaceBySession(next)
        return next
      })
    },
    [activeId],
  )

  const openSurface = useCallback(
    (kind: SurfaceKind) => {
      chooseSurface(kind)
      setDock(true)
    },
    [chooseSurface, setDock],
  )

  const toggleDiffSurface = useCallback(() => {
    if (dockOpen && activeSurface === "diff") {
      setDock(false)
      return
    }
    openSurface("diff")
  }, [dockOpen, activeSurface, openSurface, setDock])

  const toggleHistorySurface = useCallback(() => {
    if (dockOpen && activeSurface === "history") {
      setDock(false)
      return
    }
    openSurface("history")
  }, [dockOpen, activeSurface, openSurface, setDock])

  // A path clicked in a turn's changed-files row: open the Diff panel already
  // showing that file, rather than the working copy the reader has to hunt in.
  const openDiffForPath = useCallback(
    (path: string) => {
      setDiffFocus({ path, at: Date.now() })
      openSurface("diff")
    },
    [openSurface],
  )

  const openProjectFile = useCallback(
    (path: string, line?: number) => {
      setFilesFocus({ path, line: line ?? null, at: Date.now() })
      openSurface("files")
    },
    [openSurface],
  )

  useEffect(() => {
    const cwd = activeSession?.cwd
    if (!cwd) {
      setScripts([])
      return
    }
    let cancelled = false
    void window.chatHub
      .scriptsList(cwd)
      .then((file) => {
        if (!cancelled) setScripts(file.scripts)
      })
      .catch(() => {
        if (!cancelled) setScripts([])
      })
    return () => {
      cancelled = true
    }
  }, [activeSession?.id, activeSession?.cwd])

  const saveScripts = useCallback(
    async (next: ProjectScript[]) => {
      const cwd = activeSession?.cwd
      if (!cwd) return
      const saved = await window.chatHub.scriptsSave(cwd, next)
      setScripts(saved.scripts)
    },
    [activeSession?.cwd],
  )

  const runScript = useCallback(
    (script: ProjectScript) => {
      const sessionId = activeIdRef.current
      if (!sessionId) return
      stashTerminalCommand(sessionId, script.command)
      openSurface("terminal")
      if (script.autoOpenPreview && script.previewUrl) {
        const url = script.previewUrl
        window.setTimeout(() => {
          if (activeIdRef.current !== sessionId) return
          stashBrowserUrl(sessionId, url)
          openSurface("browser")
        }, SCRIPT_PREVIEW_SWITCH_MS)
      }
    },
    [openSurface],
  )

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

  function openNewSession(hint?: { project?: string; cwd?: string }) {
    const projectHint = hint?.project
    let cwd = hint?.cwd
    if (!cwd && projectHint && activeSession?.project === projectHint) {
      cwd = activeSession.cwd
    } else if (!cwd && projectHint) {
      cwd = sessions.find((s) => s.project === projectHint)?.cwd
    }
    setNewSessionHint({ project: projectHint, cwd })
    setNewSessionOpen(true)
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
      setActiveId(session.id)
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

  async function selectSession(id: string) {
    setActiveId(id)
    // Kept in step synchronously: main echoes session.active back at us, and a
    // ref that is one render stale would bounce the selection forever.
    activeIdRef.current = id
    setError(null)
    try {
      await window.chatHub.setActiveSession(id)
      if (!messagesBySession[id]) {
        const msgs = await window.chatHub.getMessages(id)
        setMessagesBySession((curr) => ({ ...curr, [id]: msgs }))
      }
      await seedOverflowFlag(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadOlderMessages() {
    const sessionId = activeId
    if (!sessionId || loadingOlderRef.current) return
    if (overflowHasMore[sessionId] === false) return
    const list = messagesBySession[sessionId] ?? []
    const beforeId = list[0]?.id ?? null
    loadingOlderRef.current = true
    setLoadingOlder(true)
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
      loadingOlderRef.current = false
      setLoadingOlder(false)
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
        setPermissions(snap.permissions)
        setInputRequests(snap.inputRequests)
      setActiveId(snap.activeSessionId)
      activeIdRef.current = snap.activeSessionId
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function sendMessage(
    text: string,
    opts?: { effort?: EffortLevel; attachments?: string[] },
  ) {
    if (!activeId) return
    setError(null)
    setSending(true)
    try {
      // Always straight through: main owns the queue, so a follow-up typed
      // mid-turn lands in the transcript and is flushed when the turn ends —
      // queueing here too would leave the notch island's replies invisible.
      await window.chatHub.sendMessage(activeId, text, {
        effort: opts?.effort ?? effort,
        attachments: opts?.attachments,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // Rethrown so the composer can hand the typed prompt back.
      throw err
    } finally {
      setSending(false)
    }
  }

  function cancelQueued(queuedId: string) {
    if (!activeId) return
    const sessionId = activeId
    void window.chatHub
      .cancelQueued(sessionId, queuedId)
      .then((queued) =>
        setQueuedBySession((curr) => ({ ...curr, [sessionId]: queued })),
      )
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  async function renameSession() {
    if (!activeSession) return
    const next = window.prompt("Rename session", activeSession.title)
    if (!next?.trim()) return
    try {
      const s = await window.chatHub.renameSession(activeSession.id, next.trim())
      setSessions((curr) => curr.map((x) => (x.id === s.id ? s : x)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function changeEffort(next: EffortLevel) {
    setEffort(next)
    void window.chatHub.setGeneralConfig({ defaultEffort: next }).catch(() => {})
  }

  /**
   * The composer chip belongs to the session in front of you. Without an active
   * session there is nothing to scope it to, so it falls back to editing the
   * global default — which is also what Settings edits.
   */
  async function changePermission(mode: PermissionMode) {
    try {
      if (activeId) {
        await window.chatHub.setSessionPermission(activeId, mode)
        return
      }
      await changeGlobalPermission(mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

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

  async function abortSession() {
    if (!activeId) return
    try {
      await window.chatHub.abortSession(activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
        if (activeSession) setDock(!dockOpen)
        return
      }
      if (meta && e.altKey && e.code.startsWith("Digit")) {
        const script = scripts.find((s) => s.hotkey === e.code.slice(5))
        if (script && activeSession) {
          e.preventDefault()
          runScript(script)
        }
        return
      }
      // Overlays own their own Escape; only a bare Escape stops the agent.
      if (e.key === "Escape" && !anyOverlayOpen) {
        if (activeSession?.status === "running") {
          e.preventDefault()
          void abortSession()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    anyOverlayOpen,
    activeSession?.id,
    activeSession?.status,
    dockOpen,
    scripts,
    runScript,
    setDock,
    toggleDiffSurface,
    toggleHistorySurface,
  ])

  async function openFolder() {
    if (!activeSession) return
    try {
      await window.chatHub.openPath(activeSession.cwd)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openEditor() {
    if (!activeSession) return
    try {
      await window.chatHub.openInEditor(activeSession.cwd)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function changeModel(model: string) {
    if (!activeId) return
    try {
      const next = await window.chatHub.setSessionModel(activeId, model)
      setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function applyMode(modeId: string) {
    if (!activeId) return
    // Empty id = "No mode": clears the preset but leaves model/permission alone.
    const mode = modeId ? modes.find((m) => m.id === modeId) : undefined
    try {
      const next = await window.chatHub.applySessionMode(activeId, {
        modeId: mode?.id,
        systemPrompt: mode?.systemPrompt,
        model: mode?.model,
        permissionMode: mode?.permissionMode,
      })
      setSessions((curr) => curr.map((s) => (s.id === next.id ? next : s)))
      // Effort is composer state, not a session field — set it here so the mode's
      // effort actually takes hold on the next turn.
      if (mode?.effort) setEffort(mode.effort)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

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

  const showDock = dockOpen && activeSession !== null

  return (
    <div
      className={`app ${sidebarCollapsed ? "sidebar-is-collapsed" : ""} ${
        showDock ? "dock-is-open" : ""
      }`}
      style={{ "--dock-w": `${dockWidth}px` } as CSSProperties}
    >
      <Sidebar
        sessions={sessions}
        messagesBySession={messagesBySession}
        projects={projects}
        activeId={activeId}
        busy={busy}
        collapsed={sidebarCollapsed}
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
      <div className="main-column">
        <ChatView
          session={activeSession}
          sessions={sessions}
          anyOverlayOpen={anyOverlayOpen}
          onboard={
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
              : null
          }
          highlightMessageId={
            highlight && highlight.sessionId === activeId
              ? highlight.messageId
              : null
          }
          onHighlightShown={clearHighlight}
          usage={activeId ? (usageBySession[activeId] ?? null) : null}
          pendingPermissions={
            activeId ? permissions.filter((p) => p.sessionId === activeId) : []
          }
          onResolvePermission={(id, allow) => void resolvePermission(id, allow)}
          pendingInputRequests={
            activeId ? inputRequests.filter((request) => request.sessionId === activeId) : []
          }
          onResolveInput={(id, answers) => void resolveAgentInput(id, answers)}
          messages={messages}
          hasOlderMessages={
            activeId ? overflowHasMore[activeId] === true : false
          }
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlderMessages()}
          providers={providers}
          models={sessionModels}
          modes={modes}
          onApplyMode={(id) => void applyMode(id)}
          permissionMode={activeSession?.permissionMode ?? permissionMode}
          effort={effort}
          git={git}
          error={error}
          sending={sending}
          queued={activeId ? (queuedBySession[activeId] ?? []) : []}
          onCancelQueued={cancelQueued}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onModelChange={(m) => void changeModel(m)}
          onPermissionChange={(m) => void changePermission(m)}
          onEffortChange={changeEffort}
          onSend={sendMessage}
          onAbort={() => void abortSession()}
          onCreate={() => openNewSession()}
          onOpenFolder={() => void openFolder()}
          onOpenEditor={() => void openEditor()}
          onCommit={() => openSurface("diff")}
          onRename={() => void renameSession()}
          onUnsettle={() => {
            if (activeId) setSessionSettled(activeId, false)
          }}
          scripts={scripts}
          onRunScript={runScript}
          onSaveScripts={saveScripts}
          onOpenDiff={openDiffForPath}
          dockOpen={showDock}
          onToggleDock={() => setDock(!dockOpen)}
        />
      </div>
      {showDock && activeSession ? (
        <SurfaceDock
          session={activeSession}
          kind={activeSurface}
          width={dockWidth}
          gitRefreshKey={gitRefresh}
          diffFocus={diffFocus}
          filesFocus={filesFocus}
          hookRuns={activeId ? (hooksBySession[activeId] ?? []) : []}
          agentActions={agentActions}
          sessions={sessions}
          messagesBySession={messagesBySession}
          usageBySession={usageBySession}
          queuedBySession={queuedBySession}
          onSelectSession={(id) => void selectSession(id)}
          onGitChanged={refreshGit}
          onSelectKind={chooseSurface}
          onWidthChange={setDockWidth}
          onWidthCommit={saveDockWidth}
          onClose={() => setDock(false)}
        />
      ) : null}
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
        setPermissions(snap.permissions)
        setInputRequests(snap.inputRequests)
              setActiveId(snap.activeSessionId)
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
          onSelect={(id) => void selectSession(id)}
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
        onClose={() => setNewSessionOpen(false)}
        onCreate={createSessionFromDraft}
      />
    </div>
  )
}
