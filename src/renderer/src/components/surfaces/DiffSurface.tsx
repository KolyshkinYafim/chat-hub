import { useEffect, useState } from "react"
import type { AgentAction } from "../../lib/agent-actions"
import {
  buildReviewMessage,
  clearComments,
  listComments,
  onDiffCommentsChanged,
} from "../../lib/diff-comments"
import { stashComposerInsert } from "../../lib/pending-prompt"
import { SourceControl } from "../SourceControl"
import { AgentAuditTrail } from "./AgentAuditTrail"

type Props = {
  cwd: string
  sessionId: string
  refreshKey: number
  focus: { path: string; at: number } | null
  /** Tool calls from the active session transcript (read-only audit trail). */
  actions?: AgentAction[]
  onClose: () => void
  onChanged: () => void
}

export function DiffSurface({
  cwd,
  sessionId,
  refreshKey,
  focus,
  actions = [],
  onClose,
  onChanged,
}: Props) {
  const [, bump] = useState(0)
  useEffect(() => onDiffCommentsChanged(() => bump((v) => v + 1)), [])
  const comments = listComments(sessionId)

  function sendToComposer() {
    const message = buildReviewMessage(listComments(sessionId))
    if (message === null) return
    stashComposerInsert(sessionId, message)
    clearComments(sessionId)
  }

  return (
    <div className="surface-diff">
      <div className="surface-diff-stack">
        <AgentAuditTrail actions={actions} />
        <SourceControl
          cwd={cwd}
          sessionId={sessionId}
          refreshKey={refreshKey}
          focus={focus}
          actions={actions}
          onClose={onClose}
          onChanged={onChanged}
        />
        {comments.length > 0 ? (
          <footer className="dcm-footer">
            <span className="dcm-footer-count">
              {comments.length} comment{comments.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="tb-btn primary dcm-footer-send"
              title="Put the batch in the composer for review — nothing sends until you do"
              onClick={sendToComposer}
            >
              Send to agent
            </button>
            <button
              type="button"
              className="tb-btn"
              title="Drop all pending comments"
              onClick={() => clearComments(sessionId)}
            >
              Clear
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
