import { useCallback, useEffect, useMemo, useState } from "react"
import type { ProviderId } from "@shared/types"
import type { ProviderStatus } from "@shared/settings-types"

type Props = {
  onFinish: (opts?: { openedSession?: boolean }) => void
}

function dot(auth: ProviderStatus["auth"]): string {
  if (auth === "connected") return "ok"
  if (auth === "needs_login") return "warn"
  if (auth === "not_installed") return "err"
  return "warn"
}

/**
 * First-run onboarding: detect CLIs → connect → pick default agent/model →
 * open a folder. Shown once (persists `general.onboarded`).
 */
export function FirstRunWizard({ onFinish }: Props) {
  const [step, setStep] = useState(0)
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState<ProviderId | "">("")
  const [model, setModel] = useState("")
  const [cwd, setCwd] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const snap = await window.chatHub.getSettings()
      setStatuses(snap.statuses)
      const installed = snap.statuses.filter(
        (s) => s.id !== "mock" && s.installed,
      )
      const preferred =
        installed.find((s) => s.auth === "connected") ?? installed[0]
      if (preferred) {
        setProvider((p) => (p ? p : preferred.id))
        setModel((current) =>
          current && preferred.models.some((candidate) => candidate.id === current)
            ? current
            : preferred.defaultModel ?? preferred.models[0]?.id ?? "",
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Shadow instances share their provider id, so listing them here duplicates
  // the row and checks both radios at once.
  const real = statuses.filter((s) => s.id !== "mock" && !s.isExtra)
  const installedCount = real.filter((s) => s.installed).length
  const chosen = useMemo(
    () => statuses.find((s) => s.id === provider),
    [statuses, provider],
  )

  useEffect(() => {
    if (!chosen) return
    setModel((current) =>
      current && chosen.models.some((candidate) => candidate.id === current)
        ? current
        : chosen.defaultModel ?? chosen.models[0]?.id ?? "",
    )
  }, [chosen])

  async function finish(openedSession: boolean) {
    setBusy(true)
    try {
      if (provider) {
        await window.chatHub.setGeneralConfig({ defaultProvider: provider })
        if (model) {
          await window.chatHub.setProviderConfig(provider, {
            defaultModel: model,
          })
        }
      }
      await window.chatHub.setGeneralConfig({ onboarded: true })
      onFinish({ openedSession })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  async function browseAndOpen() {
    if (!provider) return
    setBusy(true)
    setError(null)
    try {
      const picked = cwd || (await window.chatHub.pickFolder())
      if (!picked) {
        setBusy(false)
        return
      }
      if (provider) await window.chatHub.setGeneralConfig({ defaultProvider: provider })
      if (model)
        await window.chatHub.setProviderConfig(provider, { defaultModel: model })
      await window.chatHub.createSession({
        provider,
        cwd: picked,
        model: model || undefined,
      })
      await window.chatHub.setGeneralConfig({ onboarded: true })
      onFinish({ openedSession: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="wizard-root" role="dialog" aria-modal="true">
      <div className="wizard-panel">
        <div className="wizard-head">
          <div className="wizard-brand">
            <span className="brand-glyph">⌘</span> Chat Hub
          </div>
          <div className="wizard-steps">
            {["Detect", "Connect", "Open"].map((label, i) => (
              <span
                key={label}
                className={`wizard-step ${i === step ? "on" : ""} ${
                  i < step ? "done" : ""
                }`}
              >
                <i>{i + 1}</i>
                {label}
              </span>
            ))}
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="wizard-body">
          {step === 0 ? (
            <div className="wizard-pane">
              <h1>Let's find your agents</h1>
              <p className="wizard-lead">
                Chat Hub drives the CLIs already installed on your machine. Here's
                what we detected.
              </p>
              {loading ? (
                <p className="field-hint">Scanning PATH…</p>
              ) : (
                <ul className="wizard-detect">
                  {real.map((s) => (
                    <li key={s.id}>
                      <span className={`auth-dot ${dot(s.auth)}`} />
                      <span className="wd-name">{s.label}</span>
                      <span className="wd-status">
                        {s.installed
                          ? s.auth === "connected"
                            ? "ready"
                            : s.auth === "needs_login"
                              ? "needs login"
                              : "installed"
                          : "not installed"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="wizard-actions">
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  ↻ Re-scan
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void finish(false)}
                >
                  Skip
                </button>
                <button
                  type="button"
                  className="tb-btn primary"
                  disabled={installedCount === 0}
                  onClick={() => setStep(1)}
                >
                  {installedCount === 0 ? "No agents found" : "Continue"}
                </button>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="wizard-pane">
              <h1>Connect &amp; choose a default</h1>
              <p className="wizard-lead">
                Sign in to any that need it (opens Terminal), then pick the agent
                and model for new sessions.
              </p>
              <ul className="wizard-detect">
                {real
                  .filter((s) => s.installed)
                  .map((s) => (
                    <li key={s.id}>
                      <input
                        type="radio"
                        name="wiz-provider"
                        checked={provider === s.id}
                        onChange={() => {
                          setProvider(s.id)
                          setModel(s.defaultModel ?? s.models[0]?.id ?? "")
                        }}
                      />
                      <span className={`auth-dot ${dot(s.auth)}`} />
                      <span className="wd-name">{s.label}</span>
                      {s.auth === "needs_login" && s.loginCommand ? (
                        <button
                          type="button"
                          className="tb-btn sm"
                          onClick={() => void window.chatHub.providerLogin(s.id)}
                        >
                          Login…
                        </button>
                      ) : (
                        <span className="wd-status">{s.authDetail}</span>
                      )}
                    </li>
                  ))}
              </ul>

              {chosen && chosen.models.length > 0 ? (
                <label className="form-field wizard-model">
                  <span>Default model</span>
                  <select
                    className="text-input"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {chosen.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="wizard-actions">
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => setStep(0)}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => void refresh()}
                >
                  ↻ Re-check
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="tb-btn primary"
                  disabled={!provider}
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-pane">
              <h1>Open your first project</h1>
              <p className="wizard-lead">
                Pick a real folder to start a session with{" "}
                <strong>{chosen?.label ?? provider}</strong>
                {model ? (
                  <>
                    {" "}
                    · <code>{model}</code>
                  </>
                ) : null}
                .
              </p>
              <label className="form-field">
                <span>Project folder</span>
                <div className="path-row">
                  <input
                    className="text-input"
                    value={cwd}
                    placeholder="/Users/…/your-repo"
                    onChange={(e) => setCwd(e.target.value)}
                  />
                  <button
                    type="button"
                    className="tb-btn"
                    onClick={async () => {
                      const p = await window.chatHub.pickFolder()
                      if (p) setCwd(p)
                    }}
                  >
                    Browse…
                  </button>
                </div>
              </label>
              <div className="wizard-actions">
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => setStep(1)}
                >
                  ← Back
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="tb-btn"
                  disabled={busy}
                  onClick={() => void finish(false)}
                >
                  Finish without a session
                </button>
                <button
                  type="button"
                  className="tb-btn primary"
                  disabled={busy || !provider}
                  onClick={() => void browseAndOpen()}
                >
                  {busy ? "Opening…" : "Open project & start"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
