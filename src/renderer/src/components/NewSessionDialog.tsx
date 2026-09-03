import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import type { Project, ProviderId, ProviderInfo, SessionMeta } from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { ProviderStatus } from "@shared/settings-types"
import { formatRelative } from "../lib/format"
import { shortenPath } from "../lib/short-path"
import {
  buildProjectPicks,
  filterPicks,
  moveHighlight,
  preferredAgent,
  recallFor,
  typedPathPick,
  type ProjectPick,
} from "../lib/new-session-picks"

export type NewSessionDraft = {
  cwd: string
  provider: ProviderId
  instanceId?: string
  model?: string
  title?: string
  permissionMode: PermissionMode
  worktree: boolean
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
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [instanceId, setInstanceId] = useState<string>(initialProvider)
  const [model, setModel] = useState("")
  const [title, setTitle] = useState("")
  const [worktree, setWorktree] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Set once the owner overrides the agent, so recall stops fighting them. */
  const [agentPinned, setAgentPinned] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const agents = useMemo(
    () => statuses.filter((s) => s.id !== "mock" && s.enabled),
    [statuses],
  )

  /** The fallback list, used before any probe has landed. */
  const enabledAgents = useMemo(
    () => providers.filter((p) => enabledProviderIds.includes(p.id)),
    [providers, enabledProviderIds],
  )

  const agentChips = useMemo(() => {
    if (agents.length > 0) {
      return agents.map((s) => ({
        key: s.instanceId,
        label: s.label,
        ready: s.installed,
        note: !s.installed
          ? "install"
          : s.auth === "needs_login"
            ? "log in"
            : null,
        hint: s.authDetail ?? undefined,
      }))
    }
    return enabledAgents.map((p) => ({
      key: p.id,
      label: p.label,
      ready: p.available,
      note: p.available ? null : "install",
      hint: p.description,
    }))
  }, [agents, enabledAgents])
  const status = useMemo(
    () =>
      statuses.find((s) => s.instanceId === instanceId) ??
      statuses.find((s) => s.id === (instanceId as ProviderId)),
    [statuses, instanceId],
  )
  const models = status?.models ?? []

  const picks = useMemo(
    () => buildProjectPicks(projects, sessions, hintCwd),
    [projects, sessions, hintCwd],
  )
  const rows = useMemo(() => {
    const matched = filterPicks(picks, query)
    const typed = typedPathPick(picks, query)
    return typed ? [typed, ...matched] : matched
  }, [picks, query])
  const selected: ProjectPick | null = rows[highlight] ?? rows[0] ?? null

  useEffect(() => {
    if (!open) return
    setQuery("")
    setHighlight(0)
    setTitle(projectHint ? `New · ${projectHint}` : "")
    setInstanceId(initialProvider)
    setAgentPinned(false)
    setOptionsOpen(false)
    // Keep non-Git folders working as before; users can opt into isolation
    // when the selected project is a repository.
    setWorktree(false)
    setError(null)
    let live = true
    void Promise.all([
      window.chatHub.listProjects().catch(() => [] as Project[]),
      window.chatHub.listSessions().catch(() => [] as SessionMeta[]),
    ]).then(([nextProjects, nextSessions]) => {
      if (!live) return
      setProjects(nextProjects)
      setSessions(nextSessions)
    })
    return () => {
      live = false
    }
  }, [open, initialProvider, projectHint])

  // Recall follows the highlighted folder until the owner picks an agent by
  // hand; after that the choice sticks for the rest of the dialog.
  useEffect(() => {
    if (!open || agentPinned || !selected) return
    const { instanceId: recalled } = recallFor(picks, selected.cwd)
    setInstanceId(
      preferredAgent(
        recalled,
        agents.length ? agents : enabledAgents.map((p) => ({ instanceId: p.id })),
        initialProvider,
      ),
    )
  }, [open, agentPinned, selected, picks, agents, enabledAgents, initialProvider])

  useEffect(() => {
    if (!open) return
    const st = statuses.find((s) => s.instanceId === instanceId)
    const remembered = selected ? recallFor(picks, selected.cwd).model : undefined
    const known = remembered && st?.models.some((m) => m.id === remembered)
    setModel(known ? remembered : st?.defaultModel ?? st?.models[0]?.id ?? "")
  }, [instanceId, statuses, open, selected, picks])

  useEffect(() => {
    if (!open) return
    // Keep the highlighted row in view when the arrow keys walk past the edge.
    listRef.current
      ?.querySelector<HTMLElement>("[data-highlighted='true']")
      ?.scrollIntoView({ block: "nearest" })
  }, [highlight, open, rows.length])

  const submit = useCallback(
    async (pick: ProjectPick | null, isolated: boolean) => {
      if (!pick) {
        setError("Pick a project folder")
        return
      }
      setBusy(true)
      setError(null)
      try {
        // The permission mode belongs to the Hub, not to this dialog: it is
        // echoed back unchanged so creating a chat never retunes the sessions
        // already running. It is changed on the composer chip or in Settings.
        const permissionMode = await window.chatHub
          .getSettings()
          .then((s) => s.permissionMode)
          .catch(() => DEFAULT_PERMISSION_MODE)
        await onCreate({
          cwd: pick.cwd,
          provider: (status?.id ?? instanceId) as ProviderId,
          instanceId,
          model: model || undefined,
          title: title.trim() || undefined,
          permissionMode,
          worktree: isolated,
        })
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [instanceId, model, onClose, onCreate, status, title],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // A create is already talking to the CLI; closing here would leave the
      // session half-made with nothing on screen to say so.
      if (e.key === "Escape" && !busy) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose, busy])

  if (!open) return null

  async function browse() {
    const picked = await window.chatHub.pickFolder()
    if (picked) {
      setQuery(picked)
      setHighlight(0)
    }
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (busy) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setHighlight((h) => moveHighlight(rows.length, h, e.key === "ArrowDown" ? 1 : -1))
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      // Shift starts the same chat in an isolated worktree — the one option
      // worth a modifier, because it is the reason to open the panel at all.
      void submit(selected, worktree || e.shiftKey)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onClose()
      }}
      role="presentation"
    >
      <div
        className="modal-panel new-session-panel"
        role="dialog"
        aria-modal="true"
        aria-label="New chat"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>New chat</h2>
          <button type="button" className="icon-chip ghost" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body ns-body">
          {error ? <div className="error-banner modal-err">{error}</div> : null}

          <input
            className="ns-search"
            value={query}
            autoFocus
            spellCheck={false}
            placeholder="Search projects, or paste a folder path"
            aria-label="Search projects"
            role="combobox"
            aria-expanded
            aria-controls="ns-picks"
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={onSearchKey}
          />

          <div className="ns-picks" id="ns-picks" role="listbox" ref={listRef}>
            {rows.length === 0 ? (
              <p className="ns-empty">
                Nothing matches. Paste a folder path, or browse for one.
              </p>
            ) : (
              rows.map((pick, i) => (
                <button
                  key={pick.cwd}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  data-highlighted={i === highlight}
                  className={`ns-pick${i === highlight ? " is-on" : ""}`}
                  disabled={busy}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => void submit(pick, worktree)}
                >
                  <span className="ns-pick-name">{pick.name}</span>
                  <span className="ns-pick-meta">
                    {pick.sessions > 0
                      ? `${pick.sessions} chat${pick.sessions === 1 ? "" : "s"} · ${formatRelative(pick.lastUsedAt)}`
                      : pick.pinned
                        ? "pinned"
                        : "new folder"}
                  </span>
                  <span className="ns-pick-path" title={pick.cwd}>
                    {shortenPath(pick.cwd, 56)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="ns-agents" role="radiogroup" aria-label="Agent">
            {agentChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                role="radio"
                aria-checked={chip.key === instanceId}
                className={`ns-agent${chip.key === instanceId ? " is-on" : ""}`}
                disabled={busy || !chip.ready}
                title={chip.hint}
                onClick={() => {
                  setAgentPinned(true)
                  setInstanceId(chip.key)
                }}
              >
                {chip.label}
                {chip.note ? (
                  <span className="ns-agent-note">{chip.note}</span>
                ) : null}
              </button>
            ))}
          </div>

          <details
            className="ns-options"
            open={optionsOpen}
            onToggle={(e) => setOptionsOpen(e.currentTarget.open)}
          >
            <summary>
              Options
              <span className="ns-summary-note">
                {agentLabel(status, instanceId)}
                {model ? ` · ${modelLabel(models, model)}` : ""}
                {worktree ? " · isolated" : ""}
              </span>
            </summary>

            <div className="ns-options-body">
              <div className="form-grid">
                <label className="form-field">
                  <span>Agent</span>
                  <select
                    className="text-input"
                    value={instanceId}
                    onChange={(e) => {
                      setAgentPinned(true)
                      setInstanceId(e.target.value)
                    }}
                  >
                    {/* Both lists empty means every agent is disabled in Settings;
                        an option-less combobox reads as a broken control. */}
                    {agents.length === 0 && enabledAgents.length === 0 ? (
                      <option value="">No agent enabled</option>
                    ) : null}
                    {agents.length === 0
                      ? enabledAgents.map((p) => (
                          <option key={p.id} value={p.id} disabled={!p.available}>
                            {p.label}
                            {!p.available ? " (install)" : ""}
                          </option>
                        ))
                      : agents.map((s) => (
                          <option
                            key={s.instanceId}
                            value={s.instanceId}
                            disabled={!s.installed && s.instanceId !== instanceId}
                          >
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
              </div>

              <label className="form-field">
                <span>Title (optional)</span>
                <input
                  className="text-input"
                  value={title}
                  placeholder="Short chat title"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={worktree}
                  onChange={(event) => setWorktree(event.currentTarget.checked)}
                />
                <span>
                  <strong>Isolated Git worktree</strong>
                  <small>
                    Recommended for parallel agents; starts from the current HEAD.
                    Shift+Enter does the same from the search field.
                  </small>
                </span>
              </label>

              <p className="field-hint ns-perm-note">
                Permissions are a Hub-wide setting, changed on the composer chip
                for one chat or in Settings for the default. Creating a chat no
                longer retunes the ones already running.
              </p>
            </div>
          </details>
        </div>

        <div className="ns-footer">
          <span className="ns-hint">
            {selected ? (
              <>
                <kbd>↵</kbd> start in <strong>{selected.name}</strong>
                {" · "}
                <kbd>⇧↵</kbd> isolated worktree
              </>
            ) : (
              "Pick a project folder"
            )}
          </span>
          <div className="modal-footer-actions">
            <button type="button" className="tb-btn" onClick={() => void browse()}>
              Browse…
            </button>
            <button
              type="button"
              className="tb-btn primary"
              disabled={busy || !instanceId || !selected}
              onClick={() => void submit(selected, worktree)}
            >
              {busy ? "Creating…" : "Start chat"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function agentLabel(status: ProviderStatus | undefined, instanceId: string): string {
  return status?.label ?? instanceId ?? "no agent"
}

function modelLabel(
  models: { id: string; label: string }[],
  model: string,
): string {
  return models.find((m) => m.id === model)?.label ?? model
}
