import { type ReactNode } from "react"
import { shortenPath, splitPath } from "../lib/short-path"
import {
  runLabel,
  runRange,
  runStatus,
  statusWord,
  type FeedRun,
  type FeedStep,
} from "../lib/tool-feed"

/**
 * A path keeps its tail: only the directory head is allowed to shrink, first
 * to a character budget and then, if the row is narrower still, to an ellipsis.
 * The untouched path stays on the title so a hover always answers "which one".
 */
export function PathText({ path }: { path: string }) {
  const { head, tail } = splitPath(shortenPath(path))
  return (
    <span className="feed-path" title={path}>
      {head ? <span className="feed-path-head">{head}</span> : null}
      <span className="feed-path-tail">{tail}</span>
    </span>
  )
}

/** "Read · …/main/adapters/grok.ts" — the tool, then the thing it acted on. */
export function FeedLabel({ step }: { step: FeedStep }) {
  const full = step.detail ? `${step.label} · ${step.detail}` : step.label
  return (
    <span className="activity-label" title={full}>
      <span className="feed-tool">{step.label}</span>
      {step.path !== null ? (
        <PathText path={step.path} />
      ) : step.detail ? (
        <span className="feed-detail">{step.detail}</span>
      ) : null}
    </span>
  )
}

/**
 * One row standing in for a run of cheap calls. It is a `details` rather than
 * React state so a jump from the turn timeline can open it from the DOM, and
 * so opening it costs a reflow rather than an animated height.
 */
export function FeedRunRow({
  run,
  children,
}: {
  run: FeedRun
  children: ReactNode
}) {
  const status = runStatus(run)
  const word = statusWord(status)
  return (
    <details className="feed-run">
      <summary>
        <span className="feed-run-range">{runRange(run)}</span>
        <span className={`activity-status status-${status}`} aria-hidden />
        <span className="feed-run-label">{runLabel(run)}</span>
        {word ? <span className="activity-state">{word}</span> : null}
      </summary>
      <ul className="feed-quiet">{children}</ul>
    </details>
  )
}
