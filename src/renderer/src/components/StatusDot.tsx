import type { SessionStatus } from "@shared/types"

export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`status-dot ${status}`}
      title={status}
      aria-label={status}
    />
  )
}
