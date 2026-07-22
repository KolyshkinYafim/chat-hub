import { useCallback, useEffect, useState } from "react"
import type { ProviderId } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type { ProviderStatus, SettingsSnapshot } from "@shared/settings-types"

type Props = {
  open: boolean
  onClose: () => void
  permissionMode: PermissionMode
  onPermissionChange: (mode: PermissionMode) => void
}

function authBadge(auth: ProviderStatus["auth"]): { text: string; cls: string } {
  switch (auth) {
    case "connected":
      return { text: "Connected", cls: "ok" }
    case "needs_login":
      return { text: "Needs login", cls: "warn" }
    case "not_installed":
      return { text: "Not installed", cls: "err" }
    case "n/a":
      return { text: "N/A", cls: "muted" }
    default:
      return { text: "Unknown", cls: "muted" }
  }
}

export function SettingsModal({
  open,
  onClose,
  permissionMode,
  onPermissionChange,
}: Props) {
  const [tab, setTab] = useState<"providers" | "general">("providers")
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const snap: SettingsSnapshot = await window.chatHub.getSettings()
      setStatuses(snap.statuses)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  async function login(id: ProviderId) {
    setBusyId(id)
    try {
      await window.chatHub.providerLogin(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function setDefaultModel(id: ProviderId, model: string) {
    setBusyId(id)
    try {
      const res = await window.chatHub.setProviderConfig(id, {
        defaultModel: model,
      })
      setStatuses(res.statuses)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="icon-chip" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-tabs">
          <button
            type="button"
            className={tab === "providers" ? "active" : ""}
            onClick={() => setTab("providers")}
          >
            Providers & accounts
          </button>
          <button
            type="button"
            className={tab === "general" ? "active" : ""}
            onClick={() => setTab("general")}
          >
            General
          </button>
        </div>

        {error ? <div className="error-banner modal-err">{error}</div> : null}

        <div className="modal-body">
          {tab === "providers" ? (
            <>
              <p className="modal-lead">
                Hub uses local CLIs. Connect accounts via each CLI login — status
                is detected here. Pick a default model for new sessions.
              </p>
              <div className="provider-cards">
                {loading && statuses.length === 0 ? (
                  <div className="modal-lead">Detecting providers…</div>
                ) : (
                  statuses.map((s) => {
                    const badge = authBadge(s.auth)
                    return (
                      <article key={s.id} className="provider-card">
                        <div className="provider-card-top">
                          <div>
                            <h3>{s.label}</h3>
                            <div className="provider-path mono-soft">
                              {s.binaryPath ?? "—"}
                              {s.version ? ` · ${s.version}` : ""}
                            </div>
                          </div>
                          <span className={`auth-badge ${badge.cls}`}>
                            {badge.text}
                          </span>
                        </div>
                        <p className="provider-detail">{s.authDetail}</p>
                        <div className="provider-card-actions">
                          {s.loginCommand ? (
                            <button
                              type="button"
                              className="tb-btn"
                              disabled={busyId === s.id}
                              onClick={() => void login(s.id)}
                            >
                              Login…
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="tb-btn"
                            disabled={loading}
                            onClick={() => void refresh()}
                          >
                            Re-detect
                          </button>
                          {s.models.length > 0 ? (
                            <label className="model-field">
                              <span>Default model</span>
                              <select
                                value={s.defaultModel ?? s.models[0]?.id ?? ""}
                                disabled={busyId === s.id}
                                onChange={(e) =>
                                  void setDefaultModel(s.id, e.target.value)
                                }
                              >
                                {s.models.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
            </>
          ) : (
            <div className="general-settings">
              <label className="model-field">
                <span>Default permission mode</span>
                <select
                  value={permissionMode}
                  onChange={(e) =>
                    onPermissionChange(e.target.value as PermissionMode)
                  }
                >
                  <option value="yolo">YOLO — full bypass</option>
                  <option value="acceptEdits">Edits — auto file edits</option>
                  <option value="default">Ask — CLI default</option>
                </select>
              </label>
              <p className="modal-lead">
                YOLO is recommended for daily coding. Change per-message in the
                composer chip anytime.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
