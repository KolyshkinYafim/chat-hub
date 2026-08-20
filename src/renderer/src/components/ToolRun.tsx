import { type ReactNode } from "react"
import { splitToolName } from "@shared/tool-card"
import { useExpanded } from "../lib/expansion"
import { groupFeed, stepsFromCalls } from "../lib/tool-feed"
import {
  collapseOutput,
  isFailed,
  startsOpen,
  type ToolCall,
} from "../lib/tool-runs"
import { CopyButton } from "./CopyButton"
import { DiffBody } from "./DiffBody"
import { DiffCard } from "./DiffCard"
import { FeedRunRow } from "./ToolFeed"

function StatusChip({
  call,
  live,
}: {
  call: ToolCall
  /** Only a turn still streaming can have a call that has not answered yet. */
  live: boolean
}) {
  const result = call.result
  if (!result) {
    return live ? <span className="tool-status pending">running…</span> : null
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    return <span className="tool-status failed">exit {result.exitCode}</span>
  }
  if (result.error) return <span className="tool-status failed">error</span>
  return null
}

function CallHead({
  call,
  live,
  open,
  onToggle,
}: {
  call: ToolCall
  live: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="tool-head"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="tool-caret" aria-hidden>
        {open ? "▼" : "▶"}
      </span>
      <span className="tool-title" title={call.title}>
        {call.title}
      </span>
      <StatusChip call={call} live={live} />
      <ToolKind name={call.name} />
    </button>
  )
}

function ToolKind({ name }: { name: string }) {
  const { label, server } = splitToolName(name)
  return (
    <span className="tool-kind" title={name}>
      {server ? <span className="tool-server">{server}</span> : null}
      {label}
    </span>
  )
}

function Output({ call }: { call: ToolCall }) {
  const text = call.result?.text ?? ""
  const { head, hidden } = collapseOutput(text)
  const [open, toggle] = useExpanded(`${call.key}:out`, isFailed(call))
  if (!text.trim()) return <div className="tool-output empty">no output</div>
  const showAll = open || hidden === 0
  return (
    <div className="tool-output">
      <CopyButton
        className="tool-output-copy"
        text={() => text}
        title="Copy the whole output"
      />
      <pre>
        <code>{showAll ? text : head}</code>
      </pre>
      {hidden > 0 ? (
        <button type="button" className="tool-more" onClick={toggle}>
          {open ? "Show less" : `${hidden} more lines`}
        </button>
      ) : null}
    </div>
  )
}

function CallDetail({ call }: { call: ToolCall }) {
  const args = call.args.trim()
  const editedPath = call.diff !== null ? (call.meta.paths?.[0] ?? null) : null
  return (
    <div className="tool-detail">
      {editedPath === null && args !== "" && args !== call.title ? (
        <pre className="tool-args">
          <code>{call.args}</code>
        </pre>
      ) : null}
      {call.diff !== null ? (
        editedPath !== null ? (
          <DiffCard
            path={editedPath}
            diff={call.diff}
            absoluteLines={call.meta.absLines === true}
          />
        ) : (
          <DiffBody code={call.diff} />
        )
      ) : null}
      {call.result ? <Output call={call} /> : null}
    </div>
  )
}

function Call({
  call,
  live,
  wrap,
}: {
  call: ToolCall
  live: boolean
  wrap: (className: string, children: ReactNode) => ReactNode
}) {
  const [open, toggle] = useExpanded(call.key, startsOpen(call))
  return wrap(
    isFailed(call) ? "failed" : "",
    <>
      <CallHead call={call} live={live} open={open} onToggle={toggle} />
      {open ? <CallDetail call={call} /> : null}
    </>,
  )
}

export function ToolRun({
  calls,
  live,
}: {
  calls: ToolCall[]
  live: boolean
}) {
  if (calls.length === 0) return null

  if (calls.length === 1) {
    return (
      <Call
        call={calls[0]!}
        live={live}
        wrap={(cls, children) => (
          <div className={`tool-card ${cls}`}>{children}</div>
        )}
      />
    )
  }

  const failures = calls.filter(isFailed).length
  const byKey = new Map(calls.map((call) => [call.key, call]))
  const row =
    (extra: string) =>
    (cls: string, children: ReactNode): ReactNode => (
      <li className={`tool-row ${extra} ${cls}`.trim()}>{children}</li>
    )

  return (
    <div className="tool-run">
      <div className="tool-run-head">
        <span className="tool-run-title">Ran {calls.length} commands</span>
        {failures > 0 ? (
          <span className="tool-status failed">{failures} failed</span>
        ) : null}
      </div>
      <ul className="tool-run-list">
        {groupFeed(stepsFromCalls(calls, live)).map((node) => {
          if (node.kind === "step") {
            return (
              <Call
                key={node.key}
                call={byKey.get(node.key)!}
                live={live}
                wrap={row("")}
              />
            )
          }
          if (node.steps.length === 1) {
            return (
              <Call
                key={node.key}
                call={byKey.get(node.steps[0]!.id)!}
                live={live}
                wrap={row("quiet")}
              />
            )
          }
          return (
            <li key={node.key} className="tool-row is-run">
              <FeedRunRow run={node}>
                {node.steps.map((step) => (
                  <Call
                    key={step.id}
                    call={byKey.get(step.id)!}
                    live={live}
                    wrap={row("quiet")}
                  />
                ))}
              </FeedRunRow>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
