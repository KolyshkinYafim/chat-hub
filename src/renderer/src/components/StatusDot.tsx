import type { SessionStatus } from "@shared/types"
import { statusLabel } from "../lib/format"

export function StatusDot({
  status,
  showLabel = false,
}: {
  status: SessionStatus
  showLabel?: boolean
}) {
  return (
    <span className={`status-live status-${status}`}>
      <span className={`status-dot ${status}`} aria-hidden />
      {showLabel ? (
        <span className="status-live-label">{statusLabel[status]}</span>
      ) : null}
    </span>
  )
}
