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
  instanceId?: string
  model?: string
  title?: string
  permissionMode: PermissionMode
}

type Props = {
  open: boolean
  providers: ProviderInfo[]
  enabledProviderIds: ProviderId[]
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
  enabledProviderIds,
  statuses,
  initialProvider,
  projectHint,
  hintCwd,
  onClose,
  onCreate,
}: Props) {
  const [cwd, setCwd] = useState(hintCwd ?? "")
  const [instanceId, setInstanceId] = useState<string>(initialProvider)
  const [model, setModel] = useState("")
  const [title, setTitle] = useState("")
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Selectable agents = enabled, installed instances (default + shadow homes).
  const agents = useMemo(
    () =>
      statuses.filter(
        (s) =>
          s.id !== "mock" &&
          s.enabled &&
          (s.installed || s.instanceId === instanceId),
      ),
    [statuses, instanceId],
  )
  const status = useMemo(
    () =>
      statuses.find((s) => s.instanceId === instanceId) ??
      statuses.find((s) => s.id === (instanceId as ProviderId)),
    [statuses, instanceId],
  )
  const models = status?.models ?? []

  useEffect(() => {
    if (!open) return
    setCwd(hintCwd ?? "")
    setInstanceId(initialProvider)
    setTitle(projectHint ? `New · ${projectHint}` : "")
    setPermissionMode(DEFAULT_PERMISSION_MODE)
    setError(null)
  }, [open, hintCwd, initialProvider, projectHint])

  useEffect(() => {
    if (!open) return
    const st = statuses.find((s) => s.instanceId === instanceId)
    setModel(st?.defaultModel ?? st?.models[0]?.id ?? "")
  }, [instanceId, statuses, open])

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
        provider: (status?.id ?? instanceId) as ProviderId,
        instanceId,
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
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
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
                autoFocus
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
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
              >
                {agents.length === 0
                  ? providers
                      .filter((p) => enabledProviderIds.includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id} disabled={!p.available}>
                          {p.label}
                          {!p.available ? " (install)" : ""}
                        </option>
                      ))
                  : agents.map((s) => (
                      <option key={s.instanceId} value={s.instanceId}>
                        {s.label}
                        {!s.installed ? " (install)" : ""}
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
              <span>Permissions (all sessions)</span>
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
              {/* One mode for the whole app — say so, because picking it here
                  also retunes the sessions already running. */}
              <span className="field-hint">
                {permissionMode === "default"
                  ? "Ask: the Hub cannot answer tool prompts yet — turns stall until you Stop them. Applies to every session."
                  : "Hub-wide setting: this retunes running sessions too."}
              </span>
            </label>
          </div>

          <div className="modal-footer-actions">
            <button type="button" className="tb-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="tb-btn primary" disabled={busy}>
              {busy ? "Creating…" : "Create session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
