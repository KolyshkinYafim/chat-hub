import { useEffect, useMemo, useState } from "react"
import type { ProviderId, ProviderInfo } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_LABELS,
} from "@shared/permission"
import type { ProviderStatus } from "@shared/settings-types"
import { projectFromCwd } from "@shared/project"

export type NewSessionDraft = {
  cwd: string
  provider: ProviderId
  model?: string
  title?: string
  permissionMode: PermissionMode
}

type Props = {
  open: boolean
  providers: ProviderInfo[]
  statuses: ProviderStatus[]
  initialProvider: ProviderId
  projectHint?: string
  hintCwd?: string
  onClose: () => void
  onCreate: (draft: NewSessionDraft) => Promise<void>
}

export function NewSessionDialog({
  open,
  providers,
  statuses,
  initialProvider,
  projectHint,
  hintCwd,
  onClose,
  onCreate,
}: Props) {
  const [cwd, setCwd] = useState(hintCwd ?? "")
  const [provider, setProvider] = useState<ProviderId>(initialProvider)
  const [model, setModel] = useState("")
  const [title, setTitle] = useState("")
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const status = useMemo(
    () => statuses.find((s) => s.id === provider),
    [statuses, provider],
  )
  const models = status?.models ?? []

  useEffect(() => {
    if (!open) return
    setCwd(hintCwd ?? "")
    setProvider(initialProvider)
    setTitle(projectHint ? `New · ${projectHint}` : "")
    setPermissionMode(DEFAULT_PERMISSION_MODE)
    setError(null)
  }, [open, hintCwd, initialProvider, projectHint])

  useEffect(() => {
    if (!open) return
    const st = statuses.find((s) => s.id === provider)
    setModel(st?.defaultModel ?? st?.models[0]?.id ?? "")
  }, [provider, statuses, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  async function browse() {
    const picked = await window.chatHub.pickFolder()
    if (picked) setCwd(picked)
  }

  async function submit() {
    if (!cwd.trim()) {
      setError("Pick a project folder")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onCreate({
        cwd: cwd.trim(),
        provider,
        model: model || undefined,
        title: title.trim() || undefined,
        permissionMode,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const project = cwd ? projectFromCwd(cwd) : "—"

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel new-session-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>New session</h2>
          <button type="button" className="icon-chip" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className="modal-lead">
            Project folder + agent + model. YOLO by default for daily coding.
          </p>
          {error ? <div className="error-banner modal-err">{error}</div> : null}

          <label className="form-field">
            <span>Project folder</span>
            <div className="path-row">
              <input
                className="text-input"
                value={cwd}
                placeholder="/Users/…/your-repo"
                onChange={(e) => setCwd(e.target.value)}
              />
              <button type="button" className="tb-btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
            <span className="field-hint">Project name: {project}</span>
          </label>

          <label className="form-field">
            <span>Title (optional)</span>
            <input
              className="text-input"
              value={title}
              placeholder="Short session title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="form-grid">
            <label className="form-field">
              <span>Agent</span>
              <select
                className="text-input"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                    {!p.available ? " (install)" : ""}
                  </option>
                ))}
              </select>
              {status ? (
                <span className="field-hint">
                  {status.auth === "connected"
                    ? `✓ ${status.authDetail}`
                    : status.authDetail}
                </span>
              ) : null}
            </label>

            <label className="form-field">
              <span>Model</span>
              <select
                className="text-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={models.length === 0}
              >
                {models.length === 0 ? (
                  <option value="">CLI default</option>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="form-field">
              <span>Permissions</span>
              <select
                className="text-input"
                value={permissionMode}
                onChange={(e) =>
                  setPermissionMode(e.target.value as PermissionMode)
                }
              >
                {(["yolo", "acceptEdits", "default"] as PermissionMode[]).map(
                  (m) => (
                    <option key={m} value={m}>
                      {PERMISSION_LABELS[m]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>

          <div className="modal-footer-actions">
            <button type="button" className="tb-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="tb-btn primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Creating…" : "Create session"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
