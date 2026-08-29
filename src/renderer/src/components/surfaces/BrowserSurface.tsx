import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { BrowserActivity } from "@shared/browser"
import {
  clearBrowserUrl,
  onPendingBrowserUrl,
  peekBrowserUrl,
} from "../../lib/pending-run"
import { stashComposerInsert } from "../../lib/pending-prompt"
import {
  disablePickScript,
  enablePickScript,
  readPickScript,
  type PickTarget,
} from "../../lib/pick-script"
import {
  addPick,
  buildPickMessage,
  clearPicks,
  listPicks,
  onPreviewPicksChanged,
  removePick,
} from "../../lib/preview-picks"

const DEFAULT_URL = "http://localhost:5173"

const ACTIVITY_FADE_MS = 4000

const PICK_POLL_MS = 300

const PICK_LABEL_CHARS = 32

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
  executeJavaScript: (code: string) => Promise<unknown>
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

function pickChipLabel(pick: { tag: string; text: string }): string {
  if (pick.text === "") return pick.tag
  const preview =
    pick.text.length > PICK_LABEL_CHARS
      ? `${pick.text.slice(0, PICK_LABEL_CHARS)}…`
      : pick.text
  return `${pick.tag} · ${preview}`
}

/**
 * `executeJavaScript` throws synchronously when the guest is not attached, and
 * the renderer mounts no error boundary — an escaped throw would unmount the
 * whole app, so every guest call is wrapped rather than only its promise.
 */
async function runInGuest(
  view: WebviewElement,
  script: string,
): Promise<unknown> {
  try {
    return await view.executeJavaScript(script)
  } catch {
    return undefined
  }
}

function looksLikePick(value: unknown): value is PickTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { selector?: unknown }).selector === "string" &&
    typeof (value as { tag?: unknown }).tag === "string"
  )
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
  const [picking, setPicking] = useState(false)
  const [pendingPick, setPendingPick] = useState<PickTarget | null>(null)
  const [note, setNote] = useState("")
  const [, bumpPicks] = useState(0)

  useEffect(() => onPreviewPicksChanged(() => bumpPicks((v) => v + 1)), [])
  const picks = listPicks(sessionId)

  useEffect(() => {
    const view = viewRef.current
    if (!picking || !embedded || !attached || !view) return
    const enable = () => {
      void runInGuest(view, enablePickScript())
    }
    enable()
    const timer = window.setInterval(() => {
      void runInGuest(view, readPickScript()).then((result) => {
        if (!looksLikePick(result)) return
        setPendingPick(result)
        setNote("")
      })
    }, PICK_POLL_MS)
    view.addEventListener("dom-ready", enable)
    view.addEventListener("did-navigate", enable)
    return () => {
      window.clearInterval(timer)
      view.removeEventListener("dom-ready", enable)
      view.removeEventListener("did-navigate", enable)
      void runInGuest(view, disablePickScript())
    }
  }, [picking, embedded, attached])

  const savePendingPick = useCallback(() => {
    if (pendingPick === null) return
    const trimmed = note.trim()
    if (trimmed === "") return
    addPick(sessionId, { ...pendingPick, note: trimmed })
    setPendingPick(null)
    setNote("")
  }, [pendingPick, note, sessionId])

  const discardPendingPick = useCallback(() => {
    setPendingPick(null)
    setNote("")
  }, [])

  const sendPicks = useCallback(() => {
    const message = buildPickMessage(url, listPicks(sessionId))
    if (message === null) return
    stashComposerInsert(sessionId, message)
    clearPicks(sessionId)
  }, [url, sessionId])

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
        {/* The iframe fallback has no history we can drive, so the two buttons
            would sit disabled forever with a tooltip that promised otherwise. */}
        {embedded ? (
          <>
            <button
              type="button"
              className="icon-chip"
              disabled={!canGoBack}
              title="Back"
              onClick={() => viewRef.current?.goBack()}
            >
              ‹
            </button>
            <button
              type="button"
              className="icon-chip"
              disabled={!canGoForward}
              title="Forward"
              onClick={() => viewRef.current?.goForward()}
            >
              ›
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="icon-chip"
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
        <button
          type="button"
          className={`surface-pick-toggle ${picking ? "on" : ""}`}
          disabled={!embedded || !attached}
          aria-pressed={picking}
          title={
            !embedded
              ? "Picking needs the embedded browser"
              : !attached
                ? "Waiting for the page to load"
                : picking
                  ? "Stop picking elements"
                  : "Pick an element on the page to annotate"
          }
          onClick={() => setPicking((v) => !v)}
        >
          pick
        </button>
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
      {pendingPick !== null || picks.length > 0 ? (
        <div className="surface-pick-strip">
          {picks.map((pick) => (
            <span
              key={pick.id}
              className="surface-pick-chip"
              title={`${pick.selector}\n${pick.note}`}
            >
              <span className="surface-pick-chip-label">
                {pickChipLabel(pick)}
              </span>
              <button
                type="button"
                className="icon-chip xs ghost danger"
                title="Remove this note"
                onClick={() => removePick(sessionId, pick.id)}
              >
                ×
              </button>
            </span>
          ))}
          {pendingPick !== null ? (
            <div className="surface-pick-editor">
              <span className="surface-pick-target" title={pendingPick.selector}>
                {pickChipLabel(pendingPick)}
              </span>
              <input
                autoFocus
                className="surface-pick-input"
                value={note}
                spellCheck={false}
                placeholder="Note for the agent — Enter saves, Esc discards"
                aria-label="Annotation for the picked element"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    savePendingPick()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    discardPendingPick()
                  }
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
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
            webpreferences="transparent=no"
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
      {picks.length > 0 ? (
        <footer className="dcm-footer">
          <span className="dcm-footer-count">
            {picks.length} pick{picks.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="tb-btn primary dcm-footer-send"
            title="Put the batch in the composer for review — nothing sends until you do"
            onClick={sendPicks}
          >
            Send to agent
          </button>
          <button
            type="button"
            className="tb-btn"
            title="Drop all pending picks"
            onClick={() => clearPicks(sessionId)}
          >
            Clear
          </button>
        </footer>
      ) : null}
    </div>
  )
}
