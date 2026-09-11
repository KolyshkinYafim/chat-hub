import { TASK_SOURCE_LABELS, normalizeSessionOrigin, type SessionOrigin } from "@shared/task-sources"

export function OriginBadge({ origin }: { origin?: SessionOrigin }) {
  if (!origin) return null
  let safe: SessionOrigin | undefined
  try { safe = normalizeSessionOrigin(origin) } catch { return null }
  if (!safe) return null
  return (
    <a
      className={`origin-badge origin-${safe.kind}`}
      href={safe.url}
      target="_blank"
      rel="noreferrer"
      title={safe.title ?? `${TASK_SOURCE_LABELS[safe.kind]} · ${safe.ref}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      draggable={false}
    >
      <span aria-hidden>{safe.kind === "clickup" ? "⌃" : safe.kind === "sentry" ? "△" : "↗"}</span>
      <span>{TASK_SOURCE_LABELS[safe.kind]} · {safe.ref}</span>
    </a>
  )
}
