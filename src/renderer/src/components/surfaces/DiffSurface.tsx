import { useEffect, useState } from "react"
import type { AgentAction } from "../../lib/agent-actions"
import {
  buildReviewMessage,
  clearComments,
  removeComment,
  listComments,
  onDiffCommentsChanged,
} from "../../lib/diff-comments"
import { SourceControl } from "../SourceControl"
import { AgentAuditTrail } from "./AgentAuditTrail"

type Props = {
  cwd: string
  sessionId: string
  refreshKey: number
  focus: { path: string; at: number } | null
  /** Tool calls from the active session transcript (read-only audit trail). */
  actions?: AgentAction[]
  onSend: (text: string) => Promise<void>
  onClose: () => void
  onChanged: () => void
}

export function DiffSurface({
  cwd,
  sessionId,
  refreshKey,
  focus,
  actions = [],
  onSend,
  onClose,
  onChanged,
}: Props) {
  const [, bump] = useState(0)
  const [sending, setSending] = useState(false)
  useEffect(() => onDiffCommentsChanged(() => bump((v) => v + 1)), [])
  const comments = listComments(sessionId)

  async function sendToAgent() {
    const batch = listComments(sessionId)
    const message = buildReviewMessage(batch)
    if (message === null) return
    setSending(true)
    try {
      const ok = await onSend(message).then(
        () => true,
        () => false,
      )
      if (ok) {
        for (const comment of batch) removeComment(sessionId, comment.id)
      }
    } finally {
      setSending(false)
    }
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
              disabled={sending}
              title="Send the batch to the agent as one message"
              onClick={() => void sendToAgent()}
            >
              {sending ? "Sending…" : "Send to agent"}
            </button>
            <button
              type="button"
              className="tb-btn"
              disabled={sending}
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
