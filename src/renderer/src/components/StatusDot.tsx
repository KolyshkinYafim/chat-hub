import type { SessionStatus } from "@shared/types"
import { statusLabel } from "../lib/format"
import { phaseLabel, type LivePhase } from "../lib/live-step"

export function StatusDot({
  status,
  showLabel = false,
  attention = false,
  phase = null,
}: {
  status: SessionStatus
  showLabel?: boolean
  attention?: boolean
  phase?: LivePhase | null
}) {
  const orb = status === "running" && phase !== null
  const title = orb ? phaseLabel[phase] : statusLabel[status]
  return (
    <span
      className={`status-live status-${status}`}
      title={title}
      aria-label={title}
    >
      {orb ? (
        <span className={`orb ${phase}`} aria-hidden />
      ) : (
        <span
          className={`status-dot ${status}${attention ? " attention" : ""}`}
          aria-hidden
        />
      )}
      {showLabel ? (
        <span className="status-live-label">{statusLabel[status]}</span>
      ) : null}
    </span>
  )
}
