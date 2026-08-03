import { useMemo, useState } from "react"

const DEFAULT_URL = "http://localhost:5173"

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

export function BrowserSurface() {
  const embedded = useMemo(supportsWebviewTag, [])
  const [history, setHistory] = useState<string[]>([DEFAULT_URL])
  const [cursor, setCursor] = useState(0)
  const [draft, setDraft] = useState(DEFAULT_URL)
  const [reloadNonce, setReloadNonce] = useState(0)

  const current = history[cursor]
  const canGoBack = cursor > 0
  const canGoForward = cursor < history.length - 1

  function go(delta: number) {
    const next = cursor + delta
    if (next < 0 || next >= history.length) return
    setCursor(next)
    setDraft(history[next])
  }

  function visit(raw: string) {
    const url = normalizeUrl(raw)
    if (url === null) return
    setDraft(url)
    if (url === current) {
      setReloadNonce((n) => n + 1)
      return
    }
    setHistory((curr) => [...curr.slice(0, cursor + 1), url])
    setCursor((c) => c + 1)
  }

  const viewKey = `${current}#${reloadNonce}`

  return (
    <div className="surface-browser">
      <div className="surface-browser-bar">
        <button
          type="button"
          className="surface-nav"
          disabled={!canGoBack}
          title="Back"
          onClick={() => go(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="surface-nav"
          disabled={!canGoForward}
          title="Forward"
          onClick={() => go(1)}
        >
          ›
        </button>
        <button
          type="button"
          className="surface-nav"
          title="Reload"
          onClick={() => setReloadNonce((n) => n + 1)}
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
      </div>
      <div className="surface-browser-view">
        {embedded ? (
          <webview key={viewKey} src={current} className="surface-web" />
        ) : (
          <iframe
            key={viewKey}
            src={current}
            className="surface-web"
            title="Browser surface"
          />
        )}
      </div>
    </div>
  )
}
