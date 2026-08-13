import { useCallback, useEffect, useState } from "react"
import { errorText, surfaceBridge } from "../lib/surface-bridge"

type TrustState =
  | { phase: "hidden" }
  | { phase: "untrusted"; storePath: string }
  | { phase: "granted" }

/**
 * Grok refuses to start repo-local MCP servers in a folder the user has not
 * trusted, so a session here silently gets no browser tools. Offer the grant;
 * never take it — folder trust is Grok's security boundary, not ours.
 */
export function GrokTrustBanner({
  cwd,
  provider,
}: {
  cwd: string
  provider: string
}) {
  const [state, setState] = useState<TrustState>({ phase: "hidden" })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const bridge = surfaceBridge()
  const isGrok = provider === "grok"

  useEffect(() => {
    setState({ phase: "hidden" })
    setErr(null)
    if (!isGrok || !cwd) return

    let alive = true
    void bridge
      .grokTrustStatus(cwd)
      .then((status) => {
        if (!alive || status.trusted) return
        setState({ phase: "untrusted", storePath: status.path })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [bridge, cwd, isGrok])

  useEffect(() => {
    if (state.phase !== "granted") return
    const timer = setTimeout(() => setState({ phase: "hidden" }), 8000)
    return () => clearTimeout(timer)
  }, [state.phase])

  const trust = useCallback(() => {
    setBusy(true)
    setErr(null)
    void bridge
      .grokTrustFolder(cwd)
      .then((trusted) => {
        if (trusted) setState({ phase: "granted" })
        else setErr("Grok did not record trust for this folder.")
      })
      .catch((e) => setErr(errorText(e)))
      .finally(() => setBusy(false))
  }, [bridge, cwd])

  if (!isGrok || state.phase === "hidden") return null

  if (state.phase === "granted") {
    return (
      <div className="grok-trust-banner granted" role="status">
        <div className="grok-trust-line">
          Folder trusted. Grok picks up Chat Hub&apos;s browser tools on its next
          turn.
        </div>
      </div>
    )
  }

  return (
    <div className="grok-trust-banner" role="status">
      <div className="grok-trust-line">
        Grok will not load Chat Hub&apos;s browser tools here until this folder
        is trusted.
      </div>
      <div className="grok-trust-file" title={state.storePath}>
        Your decision is recorded in {state.storePath}
      </div>
      {err ? <div className="grok-trust-error">{err}</div> : null}
      <div className="grok-trust-actions">
        <button
          type="button"
          className="tb-btn primary"
          disabled={busy}
          onClick={trust}
        >
          {busy ? "Trusting…" : "Trust this folder"}
        </button>
      </div>
    </div>
  )
}
