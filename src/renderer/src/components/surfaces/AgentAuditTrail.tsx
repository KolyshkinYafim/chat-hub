import { useState } from "react"
import type { AgentAction } from "../../lib/agent-actions"

type Props = {
  actions: AgentAction[]
  /** How many rows to show when expanded; default 12. */
  limit?: number
}

/**
 * Collapsible "what the agent did" list above the Diff surface file list.
 * Empty is fine — turn hasn't happened yet; still renders a quiet header.
 */
export function AgentAuditTrail({ actions, limit = 12 }: Props) {
  const [open, setOpen] = useState(true)
  const shown = actions.length > limit ? actions.slice(actions.length - limit) : actions
  const hidden = Math.max(0, actions.length - shown.length)

  return (
    <section className="scm-audit" aria-label="Agent actions before commit">
      <button
        type="button"
        className="scm-audit-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="scm-audit-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="scm-audit-title">Agent trail</span>
        <span className="scm-audit-count mono-soft">
          {actions.length === 0 ? "no actions yet" : `${actions.length}`}
        </span>
      </button>
      {open ? (
        actions.length === 0 ? (
          <p className="scm-hint scm-audit-empty">
            Nothing from this session yet — tool calls will land here.
          </p>
        ) : (
          <ul className="scm-audit-list">
            {hidden > 0 ? (
              <li className="scm-audit-more mono-soft">… {hidden} earlier</li>
            ) : null}
            {shown.map((a) => (
              <li
                key={a.key}
                className={`scm-audit-row status-${a.status}`}
                title={tooltip(a)}
              >
                <span className={`scm-audit-dot status-${a.status}`} aria-hidden />
                <span className="scm-audit-name">{a.name}</span>
                <span className="scm-audit-summary">{a.summary}</span>
                {a.exitCode !== undefined && a.exitCode !== 0 ? (
                  <span className="scm-audit-code mono-soft">exit {a.exitCode}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}

function tooltip(a: AgentAction): string {
  const parts = [a.summary]
  if (a.status === "error") parts.push("(failed)")
  if (a.status === "running") parts.push("(running)")
  if (a.exitCode !== undefined) parts.push(`exit ${a.exitCode}`)
  if (a.paths?.length) parts.push(a.paths.join(", "))
  return parts.join(" · ")
}
