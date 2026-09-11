import { useEffect, useState } from "react"
import type { LangfuseStatus } from "@shared/langfuse"

export function LangfuseSettings({ projectCwd }: { projectCwd?: string }) {
  const [status, setStatus] = useState<LangfuseStatus | null>(null)
  const [publicKey, setPublicKey] = useState("")
  const [secretKey, setSecretKey] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void window.chatHub.langfuseGet().then((value) => { if (live) setStatus(value) }).catch((error: unknown) => { if (live) setNotice(String(error)) })
    return () => { live = false }
  }, [])
  const run = async (test: boolean) => {
    if (!status) return
    setBusy(true); setNotice("")
    try {
      const saved = await window.chatHub.langfuseUpdate({
        enabled: status.enabled, baseUrl: status.baseUrl, metadataOnly: status.metadataOnly,
        excludedProjects: status.excludedProjects,
        ...(publicKey.trim() ? { publicKey: publicKey.trim() } : {}),
        ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
      })
      setStatus(saved); setPublicKey(""); setSecretKey("")
      setNotice(test ? await window.chatHub.langfuseTest() : "Settings saved.")
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <>
    <h2 className="section-label">Langfuse tracing</h2>
    <p className="modal-lead">See agent turns, token usage, cost and failures in your Langfuse project. Export starts only after you enable and save it.</p>
    {status ? <div className="settings-group">
      <div className="settings-row col">
        <label className="row-title"><input type="checkbox" checked={status.enabled} onChange={(e) => setStatus({ ...status, enabled: e.target.checked })} /> Send traces</label>
        <label className="row-title"><input type="checkbox" checked={status.metadataOnly} onChange={(e) => setStatus({ ...status, metadataOnly: e.target.checked })} /> Metadata only</label>
        <div className="row-desc">Metadata includes project name, provider, model, tokens and cost. Turn text is sent only when Metadata only is off. Attachments and tool output are never exported.</div>
        <label className="row-title">Base URL<input className="text-input" value={status.baseUrl} onChange={(e) => setStatus({ ...status, baseUrl: e.target.value })} placeholder="https://cloud.langfuse.com" /></label>
        <label className="row-title">Public key<input className="text-input" type="password" autoComplete="off" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder={status.hasPublicKey ? "Stored — leave blank to keep" : "pk-lf-…"} /></label>
        <label className="row-title">Secret key<input className="text-input" type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={status.hasSecretKey ? "Stored — leave blank to keep" : "sk-lf-…"} /></label>
        {projectCwd ? <label className="row-title"><input type="checkbox" checked={status.excludedProjects.includes(projectCwd)} onChange={(e) => setStatus({ ...status, excludedProjects: e.target.checked ? [...status.excludedProjects, projectCwd] : status.excludedProjects.filter((p) => p !== projectCwd) })} /> Exclude this project from tracing</label> : null}
        <div className="env-field-row">
          <button type="button" className="tb-btn primary" disabled={busy} onClick={() => void run(false)}>Save tracing settings</button>
          <button type="button" className="tb-btn" disabled={busy} onClick={() => void run(true)}>Save & test connection</button>
          <button type="button" className="tb-btn" disabled={busy || (!status.hasPublicKey && !status.hasSecretKey)} onClick={() => {
            setBusy(true)
            void window.chatHub.langfuseUpdate({ enabled: false, publicKey: "", secretKey: "" }).then((value) => { setStatus(value); setPublicKey(""); setSecretKey(""); setNotice("Keys removed. Tracing disabled.") }).catch((error: unknown) => setNotice(String(error))).finally(() => setBusy(false))
          }}>Remove keys</button>
        </div>
        <div className="row-desc">{status.pending} queued · {status.lastSentAt ? `Last sent ${new Date(status.lastSentAt).toLocaleString()}` : "No traces sent yet"}</div>
        {status.lastError ? <div className="row-desc">{status.lastError}</div> : null}
      </div>
    </div> : <p className="row-desc">Loading tracing settings…</p>}
    {notice ? <p role="status" className="row-desc">{notice}</p> : null}
  </>
}
