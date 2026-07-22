import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ChatMessage,
  GitCheckoutInfo,
  HubEvent,
  ProviderId,
  ProviderInfo,
  SessionMeta,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { ProviderStatus } from "@shared/settings-types"
import { projectFromCwd } from "@shared/project"
import { Sidebar } from "./components/Sidebar"
import { ChatView } from "./components/ChatView"
import { SettingsModal } from "./components/SettingsModal"
import {
  NewSessionDialog,
  type NewSessionDraft,
} from "./components/NewSessionDialog"

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>(
    [],
  )
  const [provider, setProvider] = useState<ProviderId>("claude")
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionHint, setNewSessionHint] = useState<{
    project?: string
    cwd?: string
  }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [git, setGit] = useState<GitCheckoutInfo | null>(null)

  const applyEvent = useCallback((event: HubEvent) => {
    switch (event.type) {
      case "sessions.replaced":
        setSessions(event.sessions)
        break
      case "session.active":
        setActiveId(event.sessionId)
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
          [event.sessionId]: event.messages,
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
      default:
        break
    }
  }, [])

  useEffect(() => {
    let unsub = () => {}
    ;(async () => {
      try {
        const [snap, prov, settings] = await Promise.all([
          window.chatHub.getSnapshot(),
          window.chatHub.listProviders(),
          window.chatHub.getSettings(),
        ])
        setSessions(snap.sessions)
        setMessagesBySession(snap.messages)
        setActiveId(snap.activeSessionId)
        setProviders(prov)
        setPermissionMode(settings.permissionMode)
        setProviderStatuses(settings.statuses)
        const firstAvailable =
          prov.find((p) => p.available && p.id !== "mock") ??
          prov.find((p) => p.available)
        if (firstAvailable) setProvider(firstAvailable.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    unsub = window.chatHub.onHubEvent(applyEvent)

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      unsub()
      window.removeEventListener("keydown", onKey)
    }
  }, [applyEvent])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  const messages = activeId ? (messagesBySession[activeId] ?? []) : []

  const sessionModels = useMemo(() => {
    const id = activeSession?.provider ?? provider
    return providerStatuses.find((s) => s.id === id)?.models ?? []
  }, [activeSession?.provider, provider, providerStatuses])

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
  }, [activeSession?.id, activeSession?.cwd, activeSession?.status])

  function openNewSession(projectHint?: string) {
    let cwd: string | undefined
    if (projectHint && activeSession?.project === projectHint) {
      cwd = activeSession.cwd
    } else if (projectHint) {
      cwd = sessions.find((s) => s.project === projectHint)?.cwd
    }
    setNewSessionHint({ project: projectHint, cwd })
    setNewSessionOpen(true)
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
        cwd: draft.cwd,
        project: projectFromCwd(draft.cwd),
        model: draft.model,
        title: draft.title,
      })
      setActiveId(session.id)
      setSessions((curr) => {
        if (curr.some((s) => s.id === session.id)) return curr
        return [session, ...curr]
      })
      setMessagesBySession((curr) => ({ ...curr, [session.id]: [] }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function selectSession(id: string) {
    setActiveId(id)
    setError(null)
    try {
      await window.chatHub.setActiveSession(id)
      if (!messagesBySession[id]) {
        const msgs = await window.chatHub.getMessages(id)
        setMessagesBySession((curr) => ({ ...curr, [id]: msgs }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteSession(id: string) {
    setError(null)
    try {
      await window.chatHub.deleteSession(id)
      const snap = await window.chatHub.getSnapshot()
      setSessions(snap.sessions)
      setMessagesBySession(snap.messages)
      setActiveId(snap.activeSessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function sendMessage(
    text: string,
    opts?: {
      effort?: "low" | "medium" | "high" | "max"
      attachments?: string[]
    },
  ) {
    if (!activeId) return
    setError(null)
    setSending(true)
    try {
      await window.chatHub.sendMessage(activeId, text, opts)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  async function renameSession() {
    if (!activeSession) return
    const next = window.prompt("Rename session", activeSession.title)
    if (!next?.trim()) return
    try {
      const s = await window.chatHub.setSessionTitle(
        activeSession.id,
        next.trim(),
      )
      setSessions((curr) => curr.map((x) => (x.id === s.id ? s : x)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function changePermission(mode: PermissionMode) {
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

  async function commit() {
    if (!activeSession) return
    const message = window.prompt(
      "Commit message",
      `chat-hub: updates in ${activeSession.project}`,
    )
    if (!message) return
    try {
      const res = await window.chatHub.gitCommit(activeSession.cwd, message)
      if (!res.ok) setError(res.output)
      else {
        setError(null)
        const info = await window.chatHub.getGitInfo(activeSession.cwd)
        setGit(info)
      }
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

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        providers={providers}
        provider={provider}
        busy={busy}
        onProviderChange={setProvider}
        onCreate={(project) => openNewSession(project)}
        onSelect={(id) => void selectSession(id)}
        onDelete={(id) => void deleteSession(id)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatView
        session={activeSession}
        messages={messages}
        providers={providers}
        provider={provider}
        models={sessionModels}
        permissionMode={permissionMode}
        git={git}
        error={error}
        sending={sending}
        onProviderChange={setProvider}
        onModelChange={(m) => void changeModel(m)}
        onPermissionChange={(m) => void changePermission(m)}
        onSend={sendMessage}
        onAbort={() => void abortSession()}
        onCreate={() => openNewSession()}
        onOpenFolder={() => void openFolder()}
        onOpenEditor={() => void openEditor()}
        onCommit={() => void commit()}
        onRename={() => void renameSession()}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          void window.chatHub.getSettings().then((s) => {
            setProviderStatuses(s.statuses)
            setPermissionMode(s.permissionMode)
          })
        }}
        permissionMode={permissionMode}
        onPermissionChange={(m) => void changePermission(m)}
      />
      <NewSessionDialog
        open={newSessionOpen}
        providers={providers}
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
