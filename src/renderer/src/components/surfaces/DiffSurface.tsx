import type { AgentAction } from "../../lib/agent-actions"
import { SourceControl } from "../SourceControl"
import { AgentAuditTrail } from "./AgentAuditTrail"

type Props = {
  cwd: string
  refreshKey: number
  focus: { path: string; at: number } | null
  /** Tool calls from the active session transcript (read-only audit trail). */
  actions?: AgentAction[]
  onClose: () => void
  onChanged: () => void
}

export function DiffSurface({
  cwd,
  refreshKey,
  focus,
  actions = [],
  onClose,
  onChanged,
}: Props) {
  return (
    <div className="surface-diff">
      <div className="surface-diff-stack">
        <AgentAuditTrail actions={actions} />
        <SourceControl
          cwd={cwd}
          refreshKey={refreshKey}
          focus={focus}
          actions={actions}
          onClose={onClose}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}
