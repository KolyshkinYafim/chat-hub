import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { BrowserActivity } from "@shared/browser"
import {
  clearBrowserUrl,
  onPendingBrowserUrl,
  peekBrowserUrl,
} from "../../lib/pending-run"

const DEFAULT_URL = "http://localhost:5173"

const ACTIVITY_FADE_MS = 4000

type WebviewElement = HTMLElement & {
  src: string
  getWebContentsId: () => number
  getURL: () => string
  getTitle: () => string
  loadURL: (url: string) => Promise<void>
  reload: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === "") return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function supportsWebviewTag(): boolean {
  if (typeof document === "undefined") return false
  const probe = document.createElement("webview") as Partial<{
    reload: () => void
  }>
  return typeof probe.reload === "function"
}

function activityLabel(activity: BrowserActivity): string {
  return activity.ok
    ? activity.summary
    : `${activity.summary} — failed`
}

type Props = {
  sessionId: string
}

export function BrowserSurface({ sessionId }: Props) {
  const embedded = useMemo(supportsWebviewTag, [])
  const viewRef = useRef<WebviewElement | null>(null)
  const initialUrlRef = useRef<string | null>(null)
  if (initialUrlRef.current === null) {
    initialUrlRef.current = peekBrowserUrl(sessionId) ?? DEFAULT_URL
  }
  const initialUrl = initialUrlRef.current
  const [url, setUrl] = useState(initialUrl)
  const [draft, setDraft] = useState(initialUrl)
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [attached, setAttached] = useState(false)
  const [activity, setActivity] = useState<BrowserActivity | null>(null)
  const [fallbackNonce, setFallbackNonce] = useState(0)

  useEffect(() => {
    const view = viewRef.current
    if (!embedded || !view) return

    const syncNav = () => {
      setCanGoBack(view.canGoBack())
      setCanGoForward(view.canGoForward())
    }
    const syncUrl = () => {
      const next = view.getURL()
      setUrl(next)
      setDraft(next)
      syncNav()
    }
    const onDomReady = () => {
      void window.chatHub
        .browserAttach(sessionId, view.getWebContentsId())
        .then(setAttached)
      syncUrl()
    }
    const onStart = () => setLoading(true)
    const onStop = () => {
      setLoading(false)
      syncUrl()
    }

    view.addEventListener("dom-ready", onDomReady)
    view.addEventListener("did-navigate", syncUrl)
    view.addEventListener("did-navigate-in-page", syncUrl)
    view.addEventListener("did-start-loading", onStart)
    view.addEventListener("did-stop-loading", onStop)
    return () => {
      view.removeEventListener("dom-ready", onDomReady)
      view.removeEventListener("did-navigate", syncUrl)
      view.removeEventListener("did-navigate-in-page", syncUrl)
      view.removeEventListener("did-start-loading", onStart)
      view.removeEventListener("did-stop-loading", onStop)
      void window.chatHub.browserDetach(sessionId)
    }
  }, [embedded, sessionId])

  useEffect(() => {
    return window.chatHub.onBrowserActivity((event) => {
      if (event.sessionId !== sessionId) return
      setActivity(event)
    })
  }, [sessionId])

  useEffect(() => {
    if (activity === null) return
    const timer = window.setTimeout(() => setActivity(null), ACTIVITY_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [activity])

  const visit = useCallback(
    (raw: string) => {
      const next = normalizeUrl(raw)
      if (next === null) return
      setDraft(next)
      const view = viewRef.current
      if (embedded && view) {
        if (next === view.getURL()) view.reload()
        else void view.loadURL(next).catch(() => setLoading(false))
        return
      }
      setUrl(next)
      setFallbackNonce((n) => n + 1)
    },
    [embedded],
  )

  useEffect(() => {
    clearBrowserUrl(sessionId)
  }, [sessionId])

  useEffect(() => {
    return onPendingBrowserUrl((id) => {
      if (id !== sessionId) return
      const next = peekBrowserUrl(sessionId)
      clearBrowserUrl(sessionId)
      if (next !== null) visit(next)
    })
  }, [sessionId, visit])

  return (
    <div className="surface-browser">
      <div className="surface-browser-bar">
        <button
          type="button"
          className="surface-nav"
          disabled={!canGoBack}
          title="Back"
          onClick={() => viewRef.current?.goBack()}
        >
          ‹
        </button>
        <button
          type="button"
          className="surface-nav"
          disabled={!canGoForward}
          title="Forward"
          onClick={() => viewRef.current?.goForward()}
        >
          ›
        </button>
        <button
          type="button"
          className="surface-nav"
          title="Reload"
          onClick={() =>
            embedded
              ? viewRef.current?.reload()
              : setFallbackNonce((n) => n + 1)
          }
        >
          ↻
        </button>
        <form
          className="surface-url-form"
          onSubmit={(e) => {
            e.preventDefault()
            visit(draft)
          }}
        >
          <input
            className="surface-url"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label="Address"
            placeholder="localhost:5173"
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        <span
          className={`surface-browser-agent ${attached ? "live" : ""}`}
          title={
            attached
              ? "The agent can drive this browser with its browser_* tools"
              : "Agent control attaches once the page is ready"
          }
        >
          {attached ? "agent ready" : "agent off"}
        </span>
      </div>
      {activity ? (
        <div
          className={`surface-browser-activity ${activity.ok ? "" : "failed"}`}
          role="status"
        >
          {activityLabel(activity)}
        </div>
      ) : null}
      <div className="surface-browser-view">
        {embedded ? (
          <webview
            ref={viewRef as unknown as React.Ref<HTMLElement>}
            src={initialUrl}
            partition="persist:chathub-browser"
            className={`surface-web ${loading ? "loading" : ""}`}
          />
        ) : (
          <iframe
            key={`${url}#${fallbackNonce}`}
            src={url}
            className="surface-web"
            title="Browser surface"
          />
        )}
      </div>
    </div>
  )
}
