import { Fragment, useCallback, useEffect, useState } from "react"
import type { ProviderId } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  DataPaths,
  EditorPref,
  EffortLevel,
  GeneralConfig,
  ProviderConfig,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtAgo(ms: number | null): string {
  if (!ms) return "never"
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

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

/** Single env-var / API-key field. Values are write-only (never read back). */
function EnvField({
  hint,
  isSet,
  disabled,
  onSave,
  onClear,
}: {
  hint: { key: string; label: string }
  isSet: boolean
  disabled: boolean
  onSave: (value: string) => void
  onClear: () => void
}) {
  const [value, setValue] = useState("")
  return (
    <div className="env-field">
      <div className="env-field-label">
        <code className="mono-soft">{hint.key}</code>
        <span className="field-hint">
          {hint.label}
          {isSet ? " · stored 🔒" : ""}
        </span>
      </div>
      <div className="env-field-row">
        <input
          type="password"
          className="text-input"
          value={value}
          placeholder={isSet ? "•••••••• (stored)" : "Paste key to store"}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          // Enter commits too: pasting a key and closing the modal with Escape
          // never blurs the field, so a blur-only save loses the key silently.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          onBlur={() => {
            const v = value.trim()
            if (v) {
              onSave(v)
              setValue("")
            }
          }}
        />
        {isSet ? (
          <button
            type="button"
            className="tb-btn"
            disabled={disabled}
            onClick={() => onClear()}
            title="Remove stored key"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

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
  const [general, setGeneral] = useState<GeneralConfig>({})
  const [dataPaths, setDataPaths] = useState<DataPaths | null>(null)
  const [tests, setTests] = useState<
    Record<string, { ok: boolean; detail: string; ms: number } | "running">
  >({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [snap, paths] = await Promise.all([
        window.chatHub.getSettings(),
        window.chatHub.getDataPaths(),
      ])
      setStatuses(snap.statuses)
      setProvidersCfg(snap.providers)
      setGeneral(snap.general)
      setDataPaths(paths)
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

  async function testConn(id: string) {
    setTests((t) => ({ ...t, [id]: "running" }))
    try {
      const res = await window.chatHub.testProvider(id)
      setTests((t) => ({ ...t, [id]: res }))
    } catch (err) {
      setTests((t) => ({
        ...t,
        [id]: {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          ms: 0,
        },
      }))
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

  async function addInstanceFor(provider: ProviderId, label: string) {
    setBusyId(provider)
    try {
      const res = await window.chatHub.addInstance(provider, {
        label: `${label} (${statuses.filter((s) => s.id === provider).length + 1})`,
      })
      setStatuses(res.statuses)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function patchInstance(
    id: string,
    patch: { label?: string; homeDir?: string; binaryPath?: string; enabled?: boolean },
  ) {
    setBusyId(id)
    try {
      const res = await window.chatHub.updateInstance(id, patch)
      setStatuses(res.statuses)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function removeInstance(id: string, label: string) {
    if (!window.confirm(`Remove instance "${label}"?`)) return
    setBusyId(id)
    try {
      const res = await window.chatHub.removeInstance(id)
      setStatuses(res.statuses)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function browseInstanceHome(id: string) {
    const picked = await window.chatHub.pickFolder()
    if (picked) await patchInstance(id, { homeDir: picked })
  }

  async function patchGeneral(patch: GeneralConfig) {
    setGeneral((g) => ({ ...g, ...patch }))
    try {
      const res = await window.chatHub.setGeneralConfig(patch)
      setGeneral(res.general)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reveal(path: string) {
    try {
      await window.chatHub.revealPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function wipeSessions() {
    if (
      !window.confirm(
        "Delete ALL sessions and transcripts? Providers, projects, and keys are kept.",
      )
    )
      return
    try {
      await window.chatHub.wipeSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Default agent is stored as a bare provider id, so shadow instances would
  // render as a second identical option that can never be selected.
  const enabledAgents = statuses.filter(
    (s) => !s.isExtra && s.id !== "mock" && s.enabled && s.installed,
  )

  return (
    <div className="settings-root" role="dialog" aria-modal="true">
      <aside className="settings-nav">
        <div className="settings-nav-brand">
          <span className="brand-glyph">⌘</span>
          <span>Chat Hub</span>
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
                    <div className="row-title">Default agent</div>
                    <div className="row-desc">
                      Pre-selected for new sessions. Persists across restarts.
                    </div>
                  </div>
                  <select
                    value={general.defaultProvider ?? ""}
                    onChange={(e) =>
                      void patchGeneral({
                        defaultProvider: e.target.value as ProviderId,
                      })
                    }
                  >
                    {enabledAgents.length === 0 ? (
                      <option value="">No agents installed</option>
                    ) : null}
                    {enabledAgents.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>

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

                <label className="settings-row">
                  <div>
                    <div className="row-title">Default effort</div>
                    <div className="row-desc">
                      Thinking budget for the composer (Claude --effort).
                    </div>
                  </div>
                  <select
                    value={general.defaultEffort ?? "high"}
                    onChange={(e) =>
                      void patchGeneral({
                        defaultEffort: e.target.value as EffortLevel,
                      })
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                    <option value="max">Max</option>
                    <option value="ultra">Ultra</option>
                  </select>
                </label>

                <label className="settings-row">
                  <div>
                    <div className="row-title">Open in editor</div>
                    <div className="row-desc">
                      Which app the “Open in editor” button launches.
                    </div>
                  </div>
                  <select
                    value={general.editor ?? "auto"}
                    onChange={(e) =>
                      void patchGeneral({ editor: e.target.value as EditorPref })
                    }
                  >
                    <option value="auto">Auto (Cursor → VS Code)</option>
                    <option value="cursor">Cursor</option>
                    <option value="code">VS Code</option>
                    <option value="finder">Finder</option>
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
                  .filter((s) => s.id !== "mock" && !s.isExtra)
                  .map((s) => {
                    const badge = authBadge(s.auth)
                    const open = expanded[s.instanceId] === true
                    const cfg = providersCfg[s.id] ?? {}
                    const configuredDefault = cfg.defaultModel
                    const selectedDefault = configuredDefault &&
                      s.models.some((model) => model.id === configuredDefault)
                      ? configuredDefault
                      : s.defaultModel
                    const extras = statuses.filter(
                      (x) => x.isExtra && x.id === s.id,
                    )
                    return (
                      <Fragment key={s.instanceId}>
                      <article
                        key={s.instanceId}
                        className={`provider-t3 ${open ? "open" : ""} ${
                          s.enabled ? "" : "provider-off"
                        }`}
                      >
                        <div className="provider-t3-head-row">
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
                                  {!s.enabled ? (
                                    <span className="ver off">off</span>
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
                          <label
                            className="switch"
                            title={
                              s.enabled
                                ? "Enabled — shown in pickers"
                                : "Disabled — hidden from pickers"
                            }
                          >
                            <input
                              type="checkbox"
                              checked={s.enabled}
                              disabled={busyId === s.id}
                              onChange={(e) =>
                                void patchProvider(s.id, {
                                  enabled: e.target.checked,
                                })
                              }
                            />
                            <span className="switch-track" />
                          </label>
                        </div>

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
                                          selectedDefault === m.id
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
                                        {selectedDefault === m.id
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

                            {s.envHints.length > 0 ? (
                              <div className="env-block">
                                <div className="models-head">
                                  <span>API keys & environment</span>
                                  <span className="field-hint">
                                    stored in OS keychain · never shown again
                                  </span>
                                </div>
                                {s.envHints.map((h) => (
                                  <EnvField
                                    key={h.key}
                                    hint={h}
                                    isSet={s.envKeys.includes(h.key)}
                                    disabled={busyId === s.id}
                                    onSave={(value) =>
                                      void patchProvider(s.id, {
                                        env: { [h.key]: value },
                                      })
                                    }
                                    onClear={() =>
                                      void patchProvider(s.id, {
                                        env: { [h.key]: "" },
                                      })
                                    }
                                  />
                                ))}
                              </div>
                            ) : null}

                            <div className="provider-card-actions">
                              <button
                                type="button"
                                className="tb-btn primary"
                                disabled={
                                  tests[s.id] === "running" || !s.installed
                                }
                                onClick={() => void testConn(s.id)}
                                title="Send a tiny real prompt to verify end-to-end"
                              >
                                {tests[s.id] === "running"
                                  ? "Testing…"
                                  : "Test connection"}
                              </button>
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

                            {tests[s.id] && tests[s.id] !== "running" ? (
                              <div
                                className={`test-result ${
                                  (
                                    tests[s.id] as {
                                      ok: boolean
                                    }
                                  ).ok
                                    ? "ok"
                                    : "err"
                                }`}
                              >
                                <span
                                  className={`auth-dot ${
                                    (tests[s.id] as { ok: boolean }).ok
                                      ? "ok"
                                      : "err"
                                  }`}
                                />
                                {(tests[s.id] as { ok: boolean }).ok
                                  ? "Connected"
                                  : "Failed"}{" "}
                                ·{" "}
                                {(tests[s.id] as { ms: number }).ms}ms —{" "}
                                {(tests[s.id] as { detail: string }).detail}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </article>

                      {extras.map((x) => (
                        <div key={x.instanceId} className="instance-card">
                          <div className="instance-head">
                            <span
                              className={`auth-dot ${authBadge(x.auth).cls}`}
                            />
                            <input
                              className="instance-label"
                              defaultValue={x.label}
                              key={`${x.instanceId}-label`}
                              onBlur={(e) => {
                                const v = e.target.value.trim()
                                if (v && v !== x.label)
                                  void patchInstance(x.instanceId, { label: v })
                              }}
                            />
                            <span className="ver">shadow home</span>
                            <label className="switch sm" title="Enabled">
                              <input
                                type="checkbox"
                                checked={x.enabled}
                                disabled={busyId === x.instanceId}
                                onChange={(e) =>
                                  void patchInstance(x.instanceId, {
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              <span className="switch-track" />
                            </label>
                          </div>
                          <div className="instance-auth">
                            {authBadge(x.auth).text}
                            {x.authDetail ? ` · ${x.authDetail}` : ""}
                          </div>
                          <div className="path-row">
                            <input
                              className="text-input"
                              placeholder="Config home (CLAUDE_CONFIG_DIR / CODEX_HOME…)"
                              defaultValue={x.homeDir ?? ""}
                              key={`${x.instanceId}-home`}
                              onBlur={(e) => {
                                const v = e.target.value.trim()
                                if (v !== (x.homeDir ?? ""))
                                  void patchInstance(x.instanceId, { homeDir: v })
                              }}
                            />
                            <button
                              type="button"
                              className="tb-btn"
                              onClick={() =>
                                void browseInstanceHome(x.instanceId)
                              }
                            >
                              Browse…
                            </button>
                          </div>
                          <div className="provider-card-actions">
                            <button
                              type="button"
                              className="tb-btn primary"
                              disabled={
                                tests[x.instanceId] === "running" ||
                                !x.installed
                              }
                              onClick={() => void testConn(x.instanceId)}
                            >
                              {tests[x.instanceId] === "running"
                                ? "Testing…"
                                : "Test"}
                            </button>
                            {x.loginCommand ? (
                              <button
                                type="button"
                                className="tb-btn"
                                onClick={() =>
                                  void window.chatHub.providerLogin(x.instanceId)
                                }
                              >
                                Login…
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="tb-btn danger"
                              onClick={() =>
                                void removeInstance(x.instanceId, x.label)
                              }
                            >
                              Remove
                            </button>
                          </div>
                          {tests[x.instanceId] &&
                          tests[x.instanceId] !== "running" ? (
                            <div
                              className={`test-result ${
                                (tests[x.instanceId] as { ok: boolean }).ok
                                  ? "ok"
                                  : "err"
                              }`}
                            >
                              <span
                                className={`auth-dot ${
                                  (tests[x.instanceId] as { ok: boolean }).ok
                                    ? "ok"
                                    : "err"
                                }`}
                              />
                              {(tests[x.instanceId] as { ms: number }).ms}ms —{" "}
                              {(tests[x.instanceId] as { detail: string }).detail}
                            </div>
                          ) : null}
                        </div>
                      ))}

                      <button
                        type="button"
                        className="add-instance-btn"
                        disabled={busyId === s.id}
                        onClick={() => void addInstanceFor(s.id, s.label)}
                      >
                        ＋ Add instance (shadow home for a second account)
                      </button>
                      </Fragment>
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
                    Append-only JSONL events for the island / tray app. Override
                    with <code>AGENT_DESKTOP_EVENTS</code>.
                  </div>
                  <code className="path-code">
                    {dataPaths?.bridgePath || "…"}
                  </code>
                  <div className="path-status">
                    <span
                      className={`auth-dot ${
                        dataPaths?.bridgeExists ? "ok" : "warn"
                      }`}
                    />
                    {dataPaths?.bridgeExists
                      ? `${fmtBytes(dataPaths.bridgeSize)} · last event ${fmtAgo(
                          dataPaths.bridgeMtime,
                        )}`
                      : "No events file yet — start a session to create it"}
                  </div>
                  {dataPaths?.bridgeExists ? (
                    <div className="provider-card-actions">
                      <button
                        type="button"
                        className="tb-btn"
                        onClick={() => void reveal(dataPaths.bridgePath)}
                      >
                        Reveal in Finder
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {tab === "advanced" ? (
            <div className="settings-section">
              <h2 className="section-label">Advanced</h2>

              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">Data folder</div>
                  <div className="row-desc">
                    Sessions, settings, projects, and encrypted keys live here.
                  </div>
                  <code className="path-code">{dataPaths?.dataDir || "…"}</code>
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!dataPaths}
                      onClick={() =>
                        dataPaths && void reveal(dataPaths.settingsPath)
                      }
                    >
                      Reveal settings.json
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!dataPaths}
                      onClick={() =>
                        dataPaths && void reveal(dataPaths.projectsPath)
                      }
                    >
                      Reveal projects.json
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-group danger-group">
                <div className="settings-row col">
                  <div className="row-title">Reset sessions</div>
                  <div className="row-desc">
                    Delete every session and transcript. Providers, API keys, and
                    pinned projects are kept.
                  </div>
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn danger"
                      onClick={() => void wipeSessions()}
                    >
                      Reset &amp; wipe sessions
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <p className="modal-lead">
                  Env overrides: <code>CHAT_HUB_PERMISSION</code>,{" "}
                  <code>CHAT_HUB_DEMO=1</code>, <code>AGENT_DESKTOP_EVENTS</code>,{" "}
                  <code>CHAT_HUB_SELFTEST=1</code>.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
