import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ChatMessage,
  HubEvent,
  ProviderId,
  ProviderInfo,
  SessionMeta,
} from "@shared/types"
import { Sidebar } from "./components/Sidebar"
import { ChatView } from "./components/ChatView"

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [provider, setProvider] = useState<ProviderId>("mock")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)

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
        const [snap, prov] = await Promise.all([
          window.chatHub.getSnapshot(),
          window.chatHub.listProviders(),
        ])
        setSessions(snap.sessions)
        setMessagesBySession(snap.messages)
        setActiveId(snap.activeSessionId)
        setProviders(prov)
        const firstAvailable = prov.find((p) => p.available)
        if (firstAvailable) setProvider(firstAvailable.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()

    unsub = window.chatHub.onHubEvent(applyEvent)
    return () => unsub()
  }, [applyEvent])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  const messages = activeId ? (messagesBySession[activeId] ?? []) : []

  async function createSession(project?: string) {
    setError(null)
    setBusy(true)
    try {
      const cwd = project
        ? `/Users/dev/projects/${project}`
        : activeSession?.cwd
      const session = await window.chatHub.createSession({
        provider,
        project: project ?? activeSession?.project,
        cwd,
        title: project ? `New task · ${project}` : undefined,
      })
      setActiveId(session.id)
      setSessions((curr) => {
        if (curr.some((s) => s.id === session.id)) return curr
        return [session, ...curr]
      })
      setMessagesBySession((curr) => ({ ...curr, [session.id]: [] }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  async function sendMessage(text: string) {
    if (!activeId) return
    setError(null)
    setSending(true)
    try {
      await window.chatHub.sendMessage(activeId, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
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

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        providers={providers}
        provider={provider}
        busy={busy}
        onProviderChange={setProvider}
        onCreate={(project) => void createSession(project)}
        onSelect={(id) => void selectSession(id)}
        onDelete={(id) => void deleteSession(id)}
      />
      <ChatView
        session={activeSession}
        messages={messages}
        providers={providers}
        provider={provider}
        error={error}
        sending={sending}
        onProviderChange={setProvider}
        onSend={sendMessage}
        onAbort={() => void abortSession()}
        onCreate={() => void createSession()}
      />
    </div>
  )
}
