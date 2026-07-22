import { useCallback, useEffect, useState } from "react"
import type { ProviderId } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  ProviderConfig,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"

type Tab =
  | "general"
  | "providers"
  | "connections"
  | "advanced"

type Props = {
  open: boolean
  onClose: () => void
  permissionMode: PermissionMode
  onPermissionChange: (mode: PermissionMode) => void
}

function authBadge(auth: ProviderStatus["auth"]): { text: string; cls: string } {
  switch (auth) {
    case "connected":
      return { text: "Authenticated", cls: "ok" }
    case "needs_login":
      return { text: "Needs login", cls: "warn" }
    case "not_installed":
      return { text: "Not installed", cls: "err" }
    case "n/a":
      return { text: "Built-in", cls: "muted" }
    default:
      return { text: "Installed · auth unverified", cls: "warn" }
  }
}

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "◎" },
  { id: "providers", label: "Providers", icon: "⬡" },
  { id: "connections", label: "Connections", icon: "⚭" },
  { id: "advanced", label: "Advanced", icon: "…" },
]

export function SettingsModal({
  open,
  onClose,
  permissionMode,
  onPermissionChange,
}: Props) {
  const [tab, setTab] = useState<Tab>("providers")
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [providersCfg, setProvidersCfg] = useState<
    SettingsSnapshot["providers"]
  >({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    claude: true,
  })
  const [bridgePath, setBridgePath] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [snap, path] = await Promise.all([
        window.chatHub.getSettings(),
        window.chatHub.getBridgePath(),
      ])
      setStatuses(snap.statuses)
      setProvidersCfg(snap.providers)
      setBridgePath(path)
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

  async function patchProvider(id: ProviderId, patch: ProviderConfig) {
    setBusyId(id)
    try {
      const res = await window.chatHub.setProviderConfig(id, patch)
      setStatuses(res.statuses)
      setProvidersCfg(res.providers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="settings-root" role="dialog" aria-modal="true">
      <aside className="settings-nav">
        <div className="settings-nav-brand">
          <span className="brand-glyph">⌘</span>
          <span>
            Chat Hub <span className="alpha">MVP</span>
          </span>
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
            >
              <span className="nav-ico">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <button type="button" className="settings-back" onClick={onClose}>
          ← Back to chat
        </button>
      </aside>

      <section className="settings-main">
        <header className="settings-main-head">
          <h1>
            {tab === "providers"
              ? "Providers"
              : tab === "general"
                ? "General"
                : tab === "connections"
                  ? "Connections"
                  : "Advanced"}
          </h1>
          {tab === "providers" ? (
            <button
              type="button"
              className="tb-btn"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "Checking…" : "↻ Refresh"}
            </button>
          ) : null}
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="settings-scroll">
          {tab === "general" ? (
            <div className="settings-section">
              <h2 className="section-label">General</h2>
              <div className="settings-group">
                <label className="settings-row">
                  <div>
                    <div className="row-title">Default permission mode</div>
                    <div className="row-desc">
                      YOLO bypasses tool prompts for daily coding. Change per
                      message in the composer anytime.
                    </div>
                  </div>
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
              </div>
            </div>
          ) : null}

          {tab === "providers" ? (
            <div className="settings-section">
              <h2 className="section-label">Providers</h2>
              <p className="modal-lead">
                Local CLIs only — Hub detects install, auth, and models. Expand a
                card to set binary path and default model.
              </p>
              <div className="provider-list-t3">
                {statuses
                  .filter((s) => s.id !== "mock")
                  .map((s) => {
                    const badge = authBadge(s.auth)
                    const open = expanded[s.id] === true
                    const cfg = providersCfg[s.id] ?? {}
                    return (
                      <article
                        key={s.id}
                        className={`provider-t3 ${open ? "open" : ""}`}
                      >
                        <button
                          type="button"
                          className="provider-t3-head"
                          onClick={() =>
                            setExpanded((e) => ({
                              ...e,
                              [s.id]: !e[s.id],
                            }))
                          }
                        >
                          <div className="provider-t3-title">
                            <span
                              className={`auth-dot ${badge.cls}`}
                              title={badge.text}
                            />
                            <div>
                              <div className="name-row">
                                <strong>{s.label}</strong>
                                {s.version ? (
                                  <span className="ver">{s.version}</span>
                                ) : null}
                              </div>
                              <div className="auth-line">
                                {badge.text}
                                {s.authDetail ? ` · ${s.authDetail}` : ""}
                              </div>
                            </div>
                          </div>
                          <span className="chev">{open ? "▾" : "▸"}</span>
                        </button>

                        {open ? (
                          <div className="provider-t3-body">
                            <label className="form-field">
                              <span>Binary path</span>
                              <input
                                className="text-input"
                                defaultValue={
                                  cfg.binaryPath ?? s.binaryPath ?? ""
                                }
                                placeholder="Auto-detect from PATH"
                                key={`${s.id}-bin-${s.binaryPath ?? ""}`}
                                onBlur={(e) => {
                                  const v = e.target.value.trim()
                                  if (v !== (cfg.binaryPath ?? s.binaryPath ?? "")) {
                                    void patchProvider(s.id, {
                                      binaryPath: v || "",
                                    })
                                  }
                                }}
                              />
                              <span className="field-hint">
                                Path to the CLI binary used by this provider.
                              </span>
                            </label>

                            {s.models.length > 0 ? (
                              <div className="models-block">
                                <div className="models-head">
                                  <span>Models</span>
                                  <span className="field-hint">
                                    {s.models.length} available
                                  </span>
                                </div>
                                <ul className="models-list">
                                  {s.models.slice(0, 24).map((m) => (
                                    <li key={m.id}>
                                      <span className="mono-soft">{m.label}</span>
                                      <button
                                        type="button"
                                        className={
                                          (cfg.defaultModel ?? s.defaultModel) ===
                                          m.id
                                            ? "star on"
                                            : "star"
                                        }
                                        title="Set as default"
                                        onClick={() =>
                                          void patchProvider(s.id, {
                                            defaultModel: m.id,
                                          })
                                        }
                                      >
                                        {(cfg.defaultModel ?? s.defaultModel) ===
                                        m.id
                                          ? "★"
                                          : "☆"}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : (
                              <p className="field-hint">
                                No model list from CLI — will use provider default.
                              </p>
                            )}

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
                            </div>
                          </div>
                        ) : null}
                      </article>
                    )
                  })}
              </div>
            </div>
          ) : null}

          {tab === "connections" ? (
            <div className="settings-section">
              <h2 className="section-label">Connections</h2>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">Session Monitor bridge</div>
                  <div className="row-desc">
                    Append-only JSONL events for the island / tray app.
                  </div>
                  <code className="path-code">{bridgePath || "…"}</code>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "advanced" ? (
            <div className="settings-section">
              <h2 className="section-label">Advanced</h2>
              <div className="settings-group">
                <p className="modal-lead">
                  Env overrides:{" "}
                  <code>CHAT_HUB_PERMISSION</code>,{" "}
                  <code>CHAT_HUB_DEMO=1</code>,{" "}
                  <code>AGENT_DESKTOP_EVENTS</code>.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
