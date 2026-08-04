import { Fragment, useCallback, useEffect, useState } from "react"
import type { ProviderId } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  DataPaths,
  EditorPref,
  EffortLevel,
  GeneralConfig,
  Mode,
  ProviderConfig,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"
import { DEFAULT_MODES } from "@shared/settings-types"
import type {
  McpServerDef,
  McpServerStatus,
  McpTransport,
} from "@shared/mcp"
import {
  formatMcpArgs,
  parseMcpArgs,
  slugifyMcpId,
} from "@shared/mcp"

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
  autoOpenDock: boolean
  onAutoOpenDockChange: (enabled: boolean) => void
  /** Active session cwd (or first pinned project) — scopes MCP config. */
  projectCwd?: string | null
}

type McpFormState = {
  id: string
  name: string
  transport: McpTransport
  command: string
  argsText: string
  url: string
  envKey: string
  envValue: string
  /** False while adding a new server (id still editable). */
  idLocked: boolean
}

function emptyMcpForm(): McpFormState {
  return {
    id: "",
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    envKey: "",
    envValue: "",
    idLocked: false,
  }
}

function statusPill(state: McpServerStatus["state"]): { text: string; cls: string } {
  switch (state) {
    case "ok":
      return { text: "ok", cls: "ok" }
    case "error":
      return { text: "error", cls: "err" }
    case "disabled":
      return { text: "off", cls: "muted" }
    default:
      return { text: "unknown", cls: "warn" }
  }
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
  autoOpenDock,
  onAutoOpenDockChange,
  projectCwd = null,
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
  const [modesDraft, setModesDraft] = useState<Mode[]>(DEFAULT_MODES)
  const [dataPaths, setDataPaths] = useState<DataPaths | null>(null)
  const [tests, setTests] = useState<
    Record<string, { ok: boolean; detail: string; ms: number } | "running">
  >({})
  const [mcpServers, setMcpServers] = useState<McpServerDef[]>([])
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  const [mcpEnvKeys, setMcpEnvKeys] = useState<Record<string, string[]>>({})
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpNotice, setMcpNotice] = useState<string | null>(null)
  /** One-shot after materialize: native files exist but are not gitignored. */
  const [mcpGitignoreWarn, setMcpGitignoreWarn] = useState<string[] | null>(
    null,
  )
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null)

  const refreshMcp = useCallback(async () => {
    if (!projectCwd) {
      setMcpServers([])
      setMcpStatuses([])
      setMcpEnvKeys({})
      return
    }
    try {
      const res = await window.chatHub.mcpList(projectCwd)
      setMcpServers(res.config.servers)
      setMcpStatuses(res.statuses)
      setMcpEnvKeys(res.envKeysByServer)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectCwd])

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
      if (projectCwd) {
        const res = await window.chatHub.mcpList(projectCwd)
        setMcpServers(res.config.servers)
        setMcpStatuses(res.statuses)
        setMcpEnvKeys(res.envKeysByServer)
      } else {
        setMcpServers([])
        setMcpStatuses([])
        setMcpEnvKeys({})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectCwd])

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

  function openMcpAdd() {
    setMcpForm(emptyMcpForm())
    setMcpNotice(null)
  }

  function openMcpEdit(server: McpServerDef) {
    setMcpForm({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      argsText: formatMcpArgs(server.args),
      url: server.url ?? "",
      envKey: server.envKeys[0] ?? "",
      envValue: "",
      idLocked: true,
    })
    setMcpNotice(null)
  }

  async function saveMcpForm() {
    if (!projectCwd || !mcpForm) return
    setMcpBusy(true)
    setMcpNotice(null)
    setError(null)
    try {
      const name = mcpForm.name.trim() || mcpForm.id.trim()
      const id = mcpForm.idLocked
        ? mcpForm.id
        : slugifyMcpId(mcpForm.id.trim() || name)
      const def: McpServerDef = {
        id,
        name: name || id,
        enabled: true,
        transport: mcpForm.transport,
        args:
          mcpForm.transport === "stdio" ? parseMcpArgs(mcpForm.argsText) : [],
        envKeys: mcpForm.envKey.trim() ? [mcpForm.envKey.trim()] : [],
      }
      if (mcpForm.transport === "stdio") {
        def.command = mcpForm.command.trim()
      } else {
        def.url = mcpForm.url.trim()
      }
      // Preserve enabled flag when editing.
      if (mcpForm.idLocked) {
        const prev = mcpServers.find((s) => s.id === id)
        if (prev) def.enabled = prev.enabled
        // Keep extra env key names already present.
        const known = new Set([
          ...def.envKeys,
          ...(prev?.envKeys ?? []),
          ...(mcpEnvKeys[id] ?? []),
        ])
        def.envKeys = [...known]
      }
      let res = await window.chatHub.mcpUpsert(projectCwd, def)
      if (mcpForm.envKey.trim() && mcpForm.envValue.trim()) {
        const keys = await window.chatHub.mcpSetEnv(id, {
          [mcpForm.envKey.trim()]: mcpForm.envValue.trim(),
        })
        setMcpEnvKeys((curr) => ({ ...curr, [id]: keys }))
        // Re-list so envKeys on the def stay in sync after materialize.
        res = await window.chatHub.mcpList(projectCwd)
      }
      setMcpServers(res.config.servers)
      setMcpStatuses(res.statuses)
      setMcpEnvKeys(res.envKeysByServer)
      setMcpForm(null)
      setMcpNotice("Server saved · CLI configs updated")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function toggleMcpEnabled(server: McpServerDef) {
    if (!projectCwd) return
    setMcpBusy(true)
    setError(null)
    try {
      const res = await window.chatHub.mcpSetEnabled(
        projectCwd,
        server.id,
        !server.enabled,
      )
      setMcpServers(res.config.servers)
      setMcpStatuses(res.statuses)
      setMcpEnvKeys(res.envKeysByServer)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function removeMcp(server: McpServerDef) {
    if (!projectCwd) return
    if (!window.confirm(`Remove MCP server "${server.name}"?`)) return
    setMcpBusy(true)
    setError(null)
    try {
      const res = await window.chatHub.mcpRemove(projectCwd, server.id)
      setMcpServers(res.config.servers)
      setMcpStatuses(res.statuses)
      setMcpEnvKeys(res.envKeysByServer)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function applyMcp() {
    if (!projectCwd) return
    setMcpBusy(true)
    setMcpNotice(null)
    setMcpGitignoreWarn(null)
    setError(null)
    try {
      const res = await window.chatHub.mcpMaterialize(projectCwd)
      if (!res.ok) throw new Error(res.error || "materialize failed")
      setMcpNotice(
        res.written.length
          ? `Applied to CLIs · ${res.written.map((p) => p.split("/").pop()).join(", ")}`
          : "Nothing to write",
      )
      if (res.unignoredNative && res.unignoredNative.length > 0) {
        setMcpGitignoreWarn(res.unignoredNative)
      }
      await refreshMcp()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }

  async function addMcpToGitignore() {
    if (!projectCwd || !mcpGitignoreWarn?.length) return
    setMcpBusy(true)
    setError(null)
    try {
      const res = await window.chatHub.mcpAddGitignore(
        projectCwd,
        mcpGitignoreWarn,
      )
      if (!res.ok) throw new Error(res.error || "gitignore update failed")
      setMcpGitignoreWarn(null)
      setMcpNotice(
        res.added.length
          ? `Added to .gitignore · ${res.added.join(", ")}`
          : "Already listed in .gitignore",
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
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

  // Keep the editable copy in sync with what's persisted; fall back to the
  // seeded defaults until the user has saved any of their own.
  useEffect(() => {
    setModesDraft(general.modes?.length ? general.modes : DEFAULT_MODES)
  }, [general.modes])

  /** Live text edits stay local; callers persist on blur / structural change. */
  function editMode(id: string, patch: Partial<Mode>) {
    setModesDraft((curr) =>
      curr.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
  }

  function commitModes(next: Mode[] = modesDraft) {
    // Drop nameless rows so a half-added mode never persists as a blank chip.
    const clean = next
      .map((m) => ({ ...m, name: m.name.trim() }))
      .filter((m) => m.name.length > 0)
    void patchGeneral({ modes: clean })
  }

  function addMode() {
    const next: Mode[] = [
      ...modesDraft,
      { id: crypto.randomUUID(), name: "New mode", systemPrompt: "" },
    ]
    setModesDraft(next)
  }

  function removeMode(id: string) {
    const next = modesDraft.filter((m) => m.id !== id)
    setModesDraft(next)
    commitModes(next)
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

                <div className="settings-row">
                  <div>
                    <div className="row-title">Auto-open diff on file edits</div>
                    <div className="row-desc">
                      Pop the dock open to Diff when the agent writes or edits
                      a file, unless you're already using Terminal, Browser or
                      Board.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={autoOpenDock}
                      onChange={(e) => onAutoOpenDockChange(e.target.checked)}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
              </div>

              <h2 className="section-label modes-head">Modes</h2>
              <p className="modes-intro">
                Presets you can attach to a session from the composer. The system
                prompt is appended every turn (Claude Code); model / effort /
                permission pre-set the session’s knobs.
              </p>
              <div className="modes-list">
                {modesDraft.map((m) => (
                  <div key={m.id} className="mode-card">
                    <div className="mode-card-row">
                      <input
                        className="mode-name"
                        value={m.name}
                        placeholder="Mode name"
                        onChange={(e) => editMode(m.id, { name: e.target.value })}
                        onBlur={() => commitModes()}
                      />
                      <button
                        type="button"
                        className="mode-del"
                        title="Delete mode"
                        onClick={() => removeMode(m.id)}
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      className="mode-prompt"
                      rows={3}
                      value={m.systemPrompt ?? ""}
                      placeholder="System prompt — how the agent should behave…"
                      onChange={(e) =>
                        editMode(m.id, { systemPrompt: e.target.value })
                      }
                      onBlur={() => commitModes()}
                    />
                    <div className="mode-knobs">
                      <input
                        className="mode-model"
                        value={m.model ?? ""}
                        placeholder="model (optional)"
                        onChange={(e) =>
                          editMode(m.id, { model: e.target.value || undefined })
                        }
                        onBlur={() => commitModes()}
                      />
                      <select
                        value={m.effort ?? ""}
                        aria-label="Effort"
                        onChange={(e) => {
                          editMode(m.id, {
                            effort: (e.target.value || undefined) as
                              | EffortLevel
                              | undefined,
                          })
                          commitModes()
                        }}
                      >
                        <option value="">effort —</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="max">max</option>
                      </select>
                      <select
                        value={m.permissionMode ?? ""}
                        aria-label="Permission"
                        onChange={(e) => {
                          editMode(m.id, {
                            permissionMode: (e.target.value || undefined) as
                              | PermissionMode
                              | undefined,
                          })
                          commitModes()
                        }}
                      >
                        <option value="">permission —</option>
                        <option value="yolo">yolo</option>
                        <option value="acceptEdits">acceptEdits</option>
                        <option value="default">default</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="tb-btn modes-add"
                onClick={addMode}
              >
                + Add mode
              </button>
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

              <h2 className="section-label" style={{ marginTop: 20 }}>
                MCP servers
              </h2>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-desc">
                    Project config at <code>.chathub/mcp.json</code> (no secrets).
                    Apply writes Claude <code>.mcp.json</code>, Codex{" "}
                    <code>.codex/config.toml</code>, and OpenCode{" "}
                    <code>opencode.json</code>. Secrets are sealed in Hub settings
                    and expanded into those local CLI files — keep them out of git
                    if they contain tokens.
                  </div>
                  {projectCwd ? (
                    <code className="path-code">{projectCwd}</code>
                  ) : (
                    <p className="row-desc">
                      Open a session or pin a project to manage MCP for a folder.
                    </p>
                  )}
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn primary"
                      disabled={!projectCwd || mcpBusy}
                      onClick={() => openMcpAdd()}
                    >
                      Add server
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!projectCwd || mcpBusy}
                      onClick={() => void applyMcp()}
                    >
                      Apply to CLIs
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!projectCwd || mcpBusy}
                      onClick={() => void refreshMcp()}
                    >
                      Refresh status
                    </button>
                  </div>
                  {mcpNotice ? (
                    <div className="path-status">
                      <span className="auth-dot ok" />
                      {mcpNotice}
                    </div>
                  ) : null}
                  {mcpGitignoreWarn && mcpGitignoreWarn.length > 0 ? (
                    <div className="mcp-gitignore-warn" role="status">
                      <div className="row-desc">
                        <strong>{mcpGitignoreWarn.join(", ")}</strong> may
                        contain secrets and is not in this project&apos;s{" "}
                        <code>.gitignore</code>. Chat Hub will not change git
                        ignore rules unless you ask.
                      </div>
                      <div className="provider-card-actions">
                        <button
                          type="button"
                          className="tb-btn primary"
                          disabled={mcpBusy}
                          onClick={() => void addMcpToGitignore()}
                        >
                          Add to .gitignore
                        </button>
                        <button
                          type="button"
                          className="tb-btn"
                          disabled={mcpBusy}
                          onClick={() => setMcpGitignoreWarn(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {!projectCwd ? null : mcpServers.length === 0 && !mcpForm ? (
                  <p className="row-desc">No MCP servers configured yet.</p>
                ) : (
                  mcpServers.map((server) => {
                    const st =
                      mcpStatuses.find((s) => s.id === server.id) ?? null
                    const pill = statusPill(st?.state ?? "unknown")
                    const line =
                      server.transport === "stdio"
                        ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim()
                        : server.url ?? ""
                    const keys = mcpEnvKeys[server.id] ?? server.envKeys
                    return (
                      <div key={server.id} className="settings-row col mcp-card">
                        <div className="mcp-card-head">
                          <span className="row-title">{server.name}</span>
                          <span className="mono-soft dim">
                            {server.transport}
                          </span>
                          <span className={`auth-badge ${pill.cls}`}>
                            {pill.text}
                          </span>
                          <label className="mcp-toggle">
                            <input
                              type="checkbox"
                              checked={server.enabled}
                              disabled={mcpBusy}
                              onChange={() => void toggleMcpEnabled(server)}
                            />
                            enabled
                          </label>
                        </div>
                        <code className="path-code">{line || "—"}</code>
                        {st?.detail ? (
                          <div className="row-desc">{st.detail}</div>
                        ) : null}
                        {keys.length > 0 ? (
                          <div className="row-desc">
                            env: {keys.map((k) => `${k} 🔒`).join(", ")}
                          </div>
                        ) : null}
                        <div className="provider-card-actions">
                          <button
                            type="button"
                            className="tb-btn"
                            disabled={mcpBusy}
                            onClick={() => openMcpEdit(server)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="tb-btn danger"
                            disabled={mcpBusy}
                            onClick={() => void removeMcp(server)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}

                {mcpForm ? (
                  <div className="settings-row col mcp-form">
                    <div className="row-title">
                      {mcpForm.idLocked ? "Edit server" : "New server"}
                    </div>
                    <label className="field-label">
                      Name
                      <input
                        className="text-input"
                        value={mcpForm.name}
                        disabled={mcpBusy}
                        onChange={(e) => {
                          const name = e.target.value
                          setMcpForm((f) =>
                            f
                              ? {
                                  ...f,
                                  name,
                                  id: f.idLocked
                                    ? f.id
                                    : slugifyMcpId(name || f.id),
                                }
                              : f,
                          )
                        }}
                      />
                    </label>
                    <label className="field-label">
                      Id
                      <input
                        className="text-input mono-soft"
                        value={mcpForm.id}
                        disabled={mcpBusy || mcpForm.idLocked}
                        onChange={(e) =>
                          setMcpForm((f) =>
                            f
                              ? {
                                  ...f,
                                  id: slugifyMcpId(e.target.value),
                                }
                              : f,
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Transport
                      <select
                        className="text-input"
                        value={mcpForm.transport}
                        disabled={mcpBusy}
                        onChange={(e) =>
                          setMcpForm((f) =>
                            f
                              ? {
                                  ...f,
                                  transport: e.target.value as McpTransport,
                                }
                              : f,
                          )
                        }
                      >
                        <option value="stdio">stdio</option>
                        <option value="http">http</option>
                      </select>
                    </label>
                    {mcpForm.transport === "stdio" ? (
                      <>
                        <label className="field-label">
                          Command
                          <input
                            className="text-input"
                            value={mcpForm.command}
                            placeholder="npx"
                            disabled={mcpBusy}
                            onChange={(e) =>
                              setMcpForm((f) =>
                                f ? { ...f, command: e.target.value } : f,
                              )
                            }
                          />
                        </label>
                        <label className="field-label">
                          Args{" "}
                          <span className="field-hint">
                            space/comma-separated, or a JSON string array
                          </span>
                          <input
                            className="text-input"
                            value={mcpForm.argsText}
                            placeholder="-y @modelcontextprotocol/server-memory"
                            disabled={mcpBusy}
                            onChange={(e) =>
                              setMcpForm((f) =>
                                f ? { ...f, argsText: e.target.value } : f,
                              )
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <label className="field-label">
                        URL
                        <input
                          className="text-input"
                          value={mcpForm.url}
                          placeholder="https://…"
                          disabled={mcpBusy}
                          onChange={(e) =>
                            setMcpForm((f) =>
                              f ? { ...f, url: e.target.value } : f,
                            )
                          }
                        />
                      </label>
                    )}
                    <label className="field-label">
                      Env key (optional)
                      <input
                        className="text-input"
                        value={mcpForm.envKey}
                        placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                        disabled={mcpBusy}
                        onChange={(e) =>
                          setMcpForm((f) =>
                            f ? { ...f, envKey: e.target.value } : f,
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Env value (write-only)
                      <input
                        type="password"
                        className="text-input"
                        value={mcpForm.envValue}
                        placeholder="Paste secret to store"
                        autoComplete="off"
                        disabled={mcpBusy}
                        onChange={(e) =>
                          setMcpForm((f) =>
                            f ? { ...f, envValue: e.target.value } : f,
                          )
                        }
                      />
                    </label>
                    <div className="provider-card-actions">
                      <button
                        type="button"
                        className="tb-btn primary"
                        disabled={mcpBusy}
                        onClick={() => void saveMcpForm()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="tb-btn"
                        disabled={mcpBusy}
                        onClick={() => setMcpForm(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
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
