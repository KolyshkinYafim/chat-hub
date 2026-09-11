import type { QueuedMessage, SessionStatus } from "@shared/types"

export type QueuedBySession = Record<string, QueuedMessage[]>

/**
 * Main holds a queue only while a turn is running or waiting on a form; a
 * turn that ends flushes or drops it before anything else happens. So a
 * status event that says the session is at rest is proof the rows are gone,
 * even if the `queue.changed` that said so was lost — as it is when a dev
 * HMR remount drops the event subscription for a moment.
 */
export function settleQueueFor(
  queued: QueuedBySession,
  sessionId: string,
  status: SessionStatus,
): QueuedBySession {
  if (status === "running" || status === "waiting_input") return queued
  const rows = queued[sessionId]
  if (!rows || rows.length === 0) return queued
  const { [sessionId]: _gone, ...rest } = queued
  void _gone
  return rest
}
