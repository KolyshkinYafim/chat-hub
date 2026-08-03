import { useState, type ReactNode } from "react"
import {
  collapseOutput,
  isFailed,
  startsOpen,
  type ToolCall,
} from "../lib/tool-runs"
import { DiffBody } from "./DiffBody"

const expandedByKey = new Map<string, boolean>()

function useExpanded(key: string, initial: boolean) {
  const [open, setOpen] = useState(() => expandedByKey.get(key) ?? initial)
  const toggle = () => {
    const next = !open
    expandedByKey.set(key, next)
    setOpen(next)
  }
  return [open, toggle] as const
}

function StatusChip({ call }: { call: ToolCall }) {
  const result = call.result
  if (!result) return <span className="tool-status pending">running…</span>
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    return <span className="tool-status failed">exit {result.exitCode}</span>
  }
  if (result.error) return <span className="tool-status failed">error</span>
  return null
}

function CallHead({
  call,
  open,
  onToggle,
}: {
  call: ToolCall
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
        {open ? "▾" : "▸"}
      </span>
      <span className="tool-title" title={call.title}>
        {call.title}
      </span>
      <StatusChip call={call} />
      <span className="tool-kind">{call.name}</span>
    </button>
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
  return (
    <div className="tool-detail">
      {args !== "" && args !== call.title ? (
        <pre className="tool-args">
          <code>{call.args}</code>
        </pre>
      ) : null}
      {call.diff !== null ? <DiffBody code={call.diff} /> : null}
      {call.result ? <Output call={call} /> : null}
    </div>
  )
}

function Call({
  call,
  wrap,
}: {
  call: ToolCall
  wrap: (className: string, children: ReactNode) => ReactNode
}) {
  const [open, toggle] = useExpanded(call.key, startsOpen(call))
  return wrap(
    isFailed(call) ? "failed" : "",
    <>
      <CallHead call={call} open={open} onToggle={toggle} />
      {open ? <CallDetail call={call} /> : null}
    </>,
  )
}

export function ToolRun({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null

  if (calls.length === 1) {
    return (
      <Call
        call={calls[0]!}
        wrap={(cls, children) => (
          <div className={`tool-card ${cls}`}>{children}</div>
        )}
      />
    )
  }

  const failures = calls.filter(isFailed).length
  return (
    <div className="tool-run">
      <div className="tool-run-head">
        <span className="tool-run-title">Ran {calls.length} commands</span>
        {failures > 0 ? (
          <span className="tool-status failed">{failures} failed</span>
        ) : null}
      </div>
      <ul className="tool-run-list">
        {calls.map((call) => (
          <Call
            key={call.key}
            call={call}
            wrap={(cls, children) => (
              <li className={`tool-row ${cls}`}>{children}</li>
            )}
          />
        ))}
      </ul>
    </div>
  )
}
