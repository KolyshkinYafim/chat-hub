import { Fragment, useCallback, useEffect, useState } from "react"
import type {
  ProviderId,
  SessionMeta,
  UsageSummary,
} from "@shared/types"
import { UsagePanel } from "./UsagePanel"
import type { PermissionMode } from "@shared/permission"
import type {
  BuildInfo,
  DataPaths,
  EditorPref,
  EffortLevel,
  GeneralConfig,
  Mode,
  ProviderConfig,
  ProviderStatus,
  SettingsSnapshot,
  StorageStats,
} from "@shared/settings-types"
import { DEFAULT_MODES } from "@shared/settings-types"
import {
  buildLabel,
  countLabel,
  formatBuildDate,
  formatBytes,
  sessionsLabel,
  supportSummary,
} from "@shared/support"
import {
  BASE_TOKENS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  isThemeColor,
  parseThemeDef,
  resolveTheme,
  THEME_TOKENS,
} from "@shared/theme"
import type { ThemeDef, ThemeToken } from "@shared/theme"
import { applyTheme } from "../lib/theme-apply"
import { formatCheckedAgo } from "../lib/provider-status"
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

const SWATCH_TOKENS: ThemeToken[] = [
  "--bg",
  "--bg-elevated",
  "--user-bg",
  "--text",
  "--accent",
  "--danger",
]

function themeColor(def: ThemeDef, token: ThemeToken): string {
  return def.tokens[token] ?? BASE_TOKENS[token]
}

function toHex6(value: string): string {
  const v = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7).toLowerCase()
  if (/^#[0-9a-fA-F]{3,4}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase()
  }
  const m = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/)
  if (m) {
    const hex = (n: string): string =>
      Math.min(255, Number(n)).toString(16).padStart(2, "0")
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
  }
  return "#000000"
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
  | "appearance"
  | "providers"
  | "usage"
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
  /** Feeds the Usage tab's per-session spend table. */
  sessions: SessionMeta[]
  cockpit?: boolean
  onCockpitChange?: (enabled: boolean) => void
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

/** Read once at launch; listed so a support thread can ask about them by name. */
const ENV_OVERRIDES: { key: string; detail: string }[] = [
  {
    key: "CHAT_HUB_PERMISSION",
    detail:
      "Permission mode a turn falls back to when the session sets none — yolo, acceptEdits or default.",
  },
  {
    key: "CHAT_HUB_DEMO",
    detail: "Set to 1 to seed the demo sessions when there are no saved ones.",
  },
  {
    key: "AGENT_DESKTOP_EVENTS",
    detail: "Path of the Session Monitor bridge JSONL, instead of the default.",
  },
  {
    key: "CHAT_HUB_SELFTEST",
    detail: "Set to 1 to run the provider self-test before the window opens.",
  },
  {
    key: "CHAT_HUB_COCKPIT",
    detail: "Set to 1 to open a glass cockpit window (vibrancy + tab strip). Spike only.",
  },
  {
    key: "CHAT_HUB_COCKPIT_VIBRANCY",
    detail: "Cockpit vibrancy material: under-window (default) or hud.",
  },
]

/** One label/value pair in an About or Storage card. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "◎" },
  { id: "appearance", label: "Appearance", icon: "◐" },
  { id: "providers", label: "Providers", icon: "⬡" },
  { id: "usage", label: "Usage", icon: "◔" },
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
  sessions,
  cockpit = false,
  onCockpitChange,
}: Props) {
  const [tab, setTab] = useState<Tab>("providers")
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [statusesCheckedAt, setStatusesCheckedAt] = useState<number | null>(
    null,
  )
  const [nowTick, setNowTick] = useState(() => Date.now())
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
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [storageBusy, setStorageBusy] = useState(false)
  const [supportNotice, setSupportNotice] = useState<string | null>(null)
  const [themeDraft, setThemeDraft] = useState<Record<string, string> | null>(
    null,
  )
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({})
  const [saveAsName, setSaveAsName] = useState("")
  const [importText, setImportText] = useState("")
  const [themeNotice, setThemeNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open || tab !== "usage") return
    let cancelled = false
    setUsageLoading(true)
    window.chatHub
      .usageSummary()
      .then((summary) => {
        if (!cancelled) setUsageSummary(summary)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setUsageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab])

  /** Walks the whole data folder, so it only runs on the tab that shows it. */
  const measureStorage = useCallback(async () => {
    setStorageBusy(true)
    try {
      setStorage(await window.chatHub.getStorageStats())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStorageBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open || tab !== "advanced") return
    let cancelled = false
    window.chatHub
      .getBuildInfo()
      .then((info) => {
        if (!cancelled) setBuildInfo(info)
      })
      .catch(() => undefined)
    void measureStorage()
    return () => {
      cancelled = true
    }
  }, [open, tab, measureStorage])

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
      setStatusesCheckedAt(snap.statusesCachedAt)
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

  const probeNow = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const probed = await window.chatHub.getProviderStatuses()
      setStatuses(probed)
      setStatusesCheckedAt(Date.now())
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
    return window.chatHub.onHubEvent((event) => {
      if (event.type === "providers.statuses") {
        setStatuses(event.statuses)
        setStatusesCheckedAt(event.cachedAt)
      }
    })
  }, [open])

  useEffect(() => {
    if (!open || tab !== "providers") return
    const timer = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open, tab])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Keep the editable copy in sync with what's persisted; fall back to the
  // seeded defaults until the user has saved any of their own. (Lives above
  // the early return so hooks run unconditionally.)
  useEffect(() => {
    setModesDraft(general.modes?.length ? general.modes : DEFAULT_MODES)
  }, [general.modes])

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

  const customThemes = general.customThemes ?? []
  const activeTheme = resolveTheme(general.themeId, customThemes)
  const draftTheme: ThemeDef = themeDraft
    ? { ...activeTheme, tokens: themeDraft }
    : activeTheme
  const themeDirty = themeDraft !== null

  function selectTheme(def: ThemeDef) {
    setThemeDraft(null)
    setHexDrafts({})
    setThemeNotice(null)
    applyTheme(def)
    void patchGeneral({ themeId: def.id })
  }

  function editThemeToken(token: ThemeToken, value: string) {
    const nextTokens = { ...(themeDraft ?? activeTheme.tokens) }
    nextTokens[token] = value
    setThemeDraft(nextTokens)
    applyTheme({ ...activeTheme, tokens: nextTokens })
  }

  function discardThemeEdits() {
    setThemeDraft(null)
    setHexDrafts({})
    applyTheme(activeTheme)
  }

  async function saveThemeAs() {
    const name = saveAsName.trim()
    if (!name) return
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`
    const def: ThemeDef = {
      id,
      name,
      tokens: { ...(themeDraft ?? activeTheme.tokens) },
    }
    setThemeDraft(null)
    setHexDrafts({})
    setSaveAsName("")
    applyTheme(def)
    await patchGeneral({ customThemes: [...customThemes, def], themeId: id })
    setThemeNotice(`Saved "${name}"`)
  }

  async function saveThemeEdits() {
    if (!themeDraft || activeTheme.builtin) return
    const updated: ThemeDef = { ...activeTheme, tokens: { ...themeDraft } }
    const next = customThemes.map((t) =>
      t.id === activeTheme.id ? updated : t,
    )
    setThemeDraft(null)
    setHexDrafts({})
    applyTheme(updated)
    await patchGeneral({ customThemes: next })
    setThemeNotice(`Saved "${updated.name}"`)
  }

  async function deleteTheme(def: ThemeDef) {
    if (!window.confirm(`Delete theme "${def.name}"?`)) return
    const patch: GeneralConfig = {
      customThemes: customThemes.filter((t) => t.id !== def.id),
    }
    if (general.themeId === def.id) {
      patch.themeId = DEFAULT_THEME_ID
      setThemeDraft(null)
      setHexDrafts({})
      applyTheme(BUILTIN_THEMES[0])
    }
    await patchGeneral(patch)
  }

  async function exportTheme() {
    const payload = {
      id: draftTheme.id,
      name: draftTheme.name,
      tokens: draftTheme.tokens,
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setThemeNotice("Theme JSON copied to clipboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function importTheme() {
    let raw: unknown
    try {
      raw = JSON.parse(importText)
    } catch {
      setError("Import failed: not valid JSON")
      return
    }
    const parsed = parseThemeDef(raw)
    if (!parsed) {
      setError("Import failed: not a valid theme")
      return
    }
    const taken =
      BUILTIN_THEMES.some((t) => t.id === parsed.id) ||
      customThemes.some((t) => t.id === parsed.id)
    const def: ThemeDef = taken
      ? { ...parsed, id: `custom-${crypto.randomUUID().slice(0, 8)}` }
      : parsed
    setImportText("")
    setThemeDraft(null)
    setHexDrafts({})
    applyTheme(def)
    await patchGeneral({
      customThemes: [...customThemes, def],
      themeId: def.id,
    })
    setThemeNotice(`Imported "${def.name}"`)
  }

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

  async function copySupportSummary() {
    if (!buildInfo) return
    try {
      await navigator.clipboard.writeText(
        supportSummary({
          build: buildInfo,
          storage,
          dataDir: dataPaths?.dataDir ?? "unknown",
        }),
      )
      setSupportNotice("Copied — paste it into the bug report")
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
                : tab === "appearance"
                  ? "Appearance"
                  : tab === "usage"
                    ? "Usage"
                    : tab === "connections"
                      ? "Connections"
                      : "Advanced"}
          </h1>
          {tab === "providers" ? (
            <div className="settings-head-tools">
              {statusesCheckedAt !== null ? (
                <span className="settings-checked-at">
                  {formatCheckedAgo(statusesCheckedAt, nowTick)}
                </span>
              ) : null}
              <button
                type="button"
                className="tb-btn"
                disabled={loading}
                onClick={() => void probeNow()}
              >
                {loading ? "Checking…" : "↻ Refresh"}
              </button>
            </div>
          ) : null}
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="settings-scroll">
          {tab === "general" ? (
            <div className="settings-section">
              <h2 className="section-label">Defaults</h2>
              <p className="modal-lead">
                What a brand-new session starts with. Every one of these can
                still be changed per session from the composer.
              </p>
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

              <h2 className="section-label">Notifications</h2>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="row-title">Completion sound</div>
                    <div className="row-desc">
                      Let the notification play the system sound when a session
                      finishes or starts waiting on your input. Focus and Do
                      Not Disturb still apply.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={general.completionSound === true}
                      onChange={(e) =>
                        void patchGeneral({ completionSound: e.target.checked })
                      }
                    />
                    <span className="switch-track" />
                  </label>
                </div>
              </div>

              <h2 className="section-label">Agents</h2>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="row-title">
                      Allow agents to control the Hub UI
                    </div>
                    <div className="row-desc">
                      Let agent hub tools open windows, focus sessions, change
                      pane layouts and open panels. UI only — these tools never
                      touch files or run commands.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={general.allowAgentHubControl !== false}
                      onChange={(e) =>
                        void patchGeneral({
                          allowAgentHubControl: e.target.checked,
                        })
                      }
                    />
                    <span className="switch-track" />
                  </label>
                </div>
              </div>

              <h2 className="section-label">Modes</h2>
              <p className="modal-lead">
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
                        className="icon-chip ghost danger"
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
              <div className="section-foot">
                <button type="button" className="tb-btn" onClick={addMode}>
                  + Add mode
                </button>
                <span className="field-hint">
                  Saved as you type · {countLabel(modesDraft.length, "mode")} ·
                  deleting the last one brings the built-in set back
                </span>
              </div>
            </div>
          ) : null}

          {tab === "appearance" ? (
            <div className="settings-section">
              <h2 className="section-label">Theme</h2>
              <p className="modal-lead">
                Sets the palette for the whole app — sidebar, transcript, diffs
                and syntax colours. Applies the moment you pick one.
              </p>
              <div className="theme-grid">
                {[...BUILTIN_THEMES, ...customThemes].map((t) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    className={
                      t.id === activeTheme.id ? "theme-card active" : "theme-card"
                    }
                    onClick={() => selectTheme(t)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") selectTheme(t)
                    }}
                  >
                    <span
                      className="theme-swatches"
                      style={{ background: themeColor(t, "--bg") }}
                    >
                      {SWATCH_TOKENS.map((tok) => (
                        <span
                          key={tok}
                          className="theme-swatch"
                          style={{ background: themeColor(t, tok) }}
                        />
                      ))}
                    </span>
                    <span className="theme-card-name">
                      {t.name}
                      {!t.builtin ? (
                        <button
                          type="button"
                          className="icon-chip xs ghost danger"
                          title="Delete theme"
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteTheme(t)
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>

              <h2 className="section-label">This window</h2>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="row-title">Cockpit mode</div>
                    <div className="row-desc">
                      Glass chrome and Chat / Terminal / Diff / Browser tabs in
                      this window only. Other windows stay as they are.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={cockpit}
                      onChange={(e) => onCockpitChange?.(e.target.checked)}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
              </div>

              <h2 className="section-label">Customize</h2>
              <p className="modal-lead">
                Edits preview instantly. Save as a new theme to keep them —
                switching presets or closing Settings discards unsaved tweaks.
              </p>
              <div className="theme-editor">
                {THEME_TOKENS.map((token) => {
                  const value = draftTheme.tokens[token] ?? BASE_TOKENS[token]
                  return (
                    <div key={token} className="theme-token-row">
                      <code className="theme-token-name">{token}</code>
                      <span
                        className="theme-token-swatch"
                        style={{ background: value }}
                      />
                      <input
                        type="color"
                        aria-label={`${token} color picker`}
                        value={toHex6(value)}
                        onChange={(e) => editThemeToken(token, e.target.value)}
                      />
                      <input
                        className="theme-token-hex"
                        spellCheck={false}
                        value={hexDrafts[token] ?? value}
                        onChange={(e) => {
                          const v = e.target.value
                          setHexDrafts((d) => ({ ...d, [token]: v }))
                          if (isThemeColor(v.trim())) {
                            editThemeToken(token, v.trim())
                          }
                        }}
                        onBlur={() =>
                          setHexDrafts((d) => {
                            const { [token]: _gone, ...rest } = d
                            return rest
                          })
                        }
                      />
                    </div>
                  )
                })}
              </div>

              <div className="theme-actions">
                {themeDirty && !activeTheme.builtin ? (
                  <button
                    type="button"
                    className="tb-btn"
                    onClick={() => void saveThemeEdits()}
                  >
                    Save changes
                  </button>
                ) : null}
                {themeDirty ? (
                  <button
                    type="button"
                    className="tb-btn"
                    onClick={discardThemeEdits}
                  >
                    Discard changes
                  </button>
                ) : null}
                <input
                  className="theme-name-input"
                  placeholder="New theme name"
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                />
                <button
                  type="button"
                  className="tb-btn"
                  disabled={!saveAsName.trim()}
                  onClick={() => void saveThemeAs()}
                >
                  Save as
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void exportTheme()}
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => selectTheme(BUILTIN_THEMES[0])}
                >
                  Reset to Midnight
                </button>
              </div>
              {themeNotice ? (
                <div className="path-status">
                  <span className="auth-dot ok" />
                  {themeNotice}
                </div>
              ) : null}

              <h2 className="section-label">Import</h2>
              <p className="modal-lead">
                Paste what “Export JSON” copies. Unknown tokens are dropped, and
                an id that is already taken gets a fresh one.
              </p>
              <div className="theme-import">
                <textarea
                  rows={3}
                  placeholder='Paste theme JSON — {"id": "...", "name": "...", "tokens": {"--bg": "#101014"}}'
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <button
                  type="button"
                  className="tb-btn"
                  disabled={!importText.trim()}
                  onClick={() => void importTheme()}
                >
                  Import
                </button>
              </div>
              <div className="section-foot">
                <span className="field-hint">
                  {countLabel(BUILTIN_THEMES.length, "built-in theme")} ·{" "}
                  {customThemes.length === 0
                    ? "none of your own yet"
                    : countLabel(customThemes.length, "saved theme")}
                </span>
              </div>
            </div>
          ) : null}

          {tab === "providers" ? (
            <div className="settings-section">
              <h2 className="section-label">Installed CLIs</h2>
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
                                onClick={() => void probeNow()}
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
              <div className="section-foot">
                <span className="field-hint">
                  {countLabel(enabledAgents.length, "agent")} ready for new
                  sessions. Missing one? Install its CLI, then Refresh.
                </span>
              </div>
            </div>
          ) : null}

          {tab === "connections" ? (
            <div className="settings-section">
              <h2 className="section-label">Session Monitor</h2>
              <p className="modal-lead">
                How Chat Hub reaches the rest of the desktop suite — the island /
                tray app reads the event file below.
              </p>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">Bridge events</div>
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
                      ? `${formatBytes(dataPaths.bridgeSize)} · last event ${fmtAgo(
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

              <h2 className="section-label">MCP servers</h2>
              <p className="modal-lead">
                Extra tools every agent in one project can call. Configured per
                folder, then written out into each CLI’s own config file.
              </p>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">This project</div>
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

                {!projectCwd ? (
                  <div className="settings-row col">
                    <div className="settings-empty">
                      <div className="settings-empty-title">
                        No project selected
                      </div>
                      <p>
                        MCP servers are configured per folder. Open a session or
                        pin a project, then come back here.
                      </p>
                    </div>
                  </div>
                ) : mcpServers.length === 0 && !mcpForm ? (
                  <div className="settings-row col">
                    <div className="settings-empty">
                      <div className="settings-empty-title">No servers yet</div>
                      <p>
                        Nothing is configured for this project, so its agents get
                        their built-in tools only. Add a server to change that.
                      </p>
                      <button
                        type="button"
                        className="tb-btn"
                        disabled={mcpBusy}
                        onClick={() => openMcpAdd()}
                      >
                        Add server
                      </button>
                    </div>
                  </div>
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
              <div className="section-foot">
                <span className="field-hint">
                  {projectCwd
                    ? `${countLabel(mcpServers.length, "server")} in this ` +
                      "project · Apply to CLIs after every change"
                    : "Per-project configuration — nothing to apply here " +
                      "without a project."}
                </span>
              </div>
            </div>
          ) : null}

          {tab === "usage" ? (
            <div className="settings-section">
              <h2 className="section-label">Usage</h2>
              <UsagePanel
                summary={usageSummary}
                loading={usageLoading}
                sessions={sessions}
              />
            </div>
          ) : null}

          {tab === "advanced" ? (
            <div className="settings-section">
              <h2 className="section-label">About this build</h2>
              <p className="modal-lead">
                Everything a bug report asks for first: which build is running,
                where its data lives, and how much of it there is.
              </p>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">
                    Chat Hub {buildInfo ? buildLabel(buildInfo) : "…"}
                  </div>
                  <div className="row-desc">
                    {!buildInfo
                      ? "Reading build identity…"
                      : buildInfo.packaged
                        ? `Packaged build · ${formatBuildDate(buildInfo.builtAt)}`
                        : "Unpackaged dev run — this code was never stamped with a commit."}
                  </div>
                  {buildInfo ? (
                    <dl className="fact-grid">
                      <Fact label="Version" value={buildInfo.version} />
                      <Fact label="Commit" value={buildInfo.commit} />
                      <Fact
                        label="Platform"
                        value={`${buildInfo.platform} ${buildInfo.arch}`}
                      />
                      <Fact label="Electron" value={buildInfo.electron} />
                      <Fact label="Chrome" value={buildInfo.chrome} />
                      <Fact label="Node" value={buildInfo.node} />
                    </dl>
                  ) : null}
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn primary"
                      disabled={!buildInfo}
                      onClick={() => void copySupportSummary()}
                    >
                      Copy for support
                    </button>
                  </div>
                  {supportNotice ? (
                    <div className="path-status">
                      <span className="auth-dot ok" />
                      {supportNotice}
                    </div>
                  ) : null}
                </div>
              </div>

              <h2 className="section-label">Data folder</h2>
              <p className="modal-lead">
                Sessions, settings, pinned projects, and encrypted keys live in
                one folder. Nothing here leaves the machine.
              </p>
              <div className="settings-group">
                <div className="settings-row col">
                  <div className="row-title">Location</div>
                  <code className="path-code">{dataPaths?.dataDir || "…"}</code>
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!dataPaths}
                      onClick={() => dataPaths && void reveal(dataPaths.dataDir)}
                    >
                      Reveal in Finder
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!dataPaths}
                      onClick={() =>
                        dataPaths && void reveal(dataPaths.settingsPath)
                      }
                    >
                      settings.json
                    </button>
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={!dataPaths}
                      onClick={() =>
                        dataPaths && void reveal(dataPaths.projectsPath)
                      }
                    >
                      projects.json
                    </button>
                  </div>
                </div>

                <div className="settings-row col">
                  <div className="row-title">Contents</div>
                  <div className="row-desc">
                    {storageBusy
                      ? "Walking the folder…"
                      : storage
                        ? "Measured just now. Wiping sessions below clears most of it."
                        : "Not measured yet."}
                  </div>
                  <dl className="fact-grid">
                    <Fact
                      label="On disk"
                      value={storage ? formatBytes(storage.dataDirBytes) : "—"}
                    />
                    <Fact
                      label="Files"
                      value={
                        storage ? countLabel(storage.fileCount, "file") : "—"
                      }
                    />
                    <Fact
                      label="Sessions"
                      value={storage ? sessionsLabel(storage) : "—"}
                    />
                    <Fact
                      label="Messages"
                      value={
                        storage
                          ? countLabel(storage.messageCount, "message")
                          : "—"
                      }
                    />
                  </dl>
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="tb-btn"
                      disabled={storageBusy}
                      onClick={() => void measureStorage()}
                    >
                      {storageBusy ? "Measuring…" : "↻ Recalculate"}
                    </button>
                  </div>
                </div>
              </div>

              <h2 className="section-label">Environment overrides</h2>
              <p className="modal-lead">
                Read from the environment when Chat Hub launches, so they only
                take effect on the next start. Settings above win at runtime.
              </p>
              <div className="settings-group">
                {ENV_OVERRIDES.map((v) => (
                  <div key={v.key} className="settings-row col">
                    <code className="env-var-name">{v.key}</code>
                    <div className="row-desc">{v.detail}</div>
                  </div>
                ))}
              </div>

              <h2 className="section-label">Danger zone</h2>
              <div className="settings-group danger-group">
                <div className="settings-row col">
                  <div className="row-title">Reset sessions</div>
                  <div className="row-desc">
                    Delete every session and transcript. Providers, API keys, and
                    pinned projects are kept. This cannot be undone.
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
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
