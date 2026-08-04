import { useState } from "react"
import type { PlanStep, PlanStepStatus } from "@shared/tool-card"
import { planProgress } from "../lib/tool-runs"

export type PlanStepsProps = {
  steps: PlanStep[]
  /** Short label for the header, e.g. current step text. */
  title?: string
  /** Tool name badge (TodoWrite / update_plan). */
  toolName?: string
  /** Stable key for expansion memory across remounts. */
  expandKey?: string
  /** Start expanded (default true while a step is in_progress). */
  defaultOpen?: boolean
}

const expansionRemembered = new Map<string, boolean>()

/**
 * Collapsible plan checklist — Claude TodoWrite / Codex update_plan.
 * No per-step diff stats in v1 (out of scope).
 */
export function PlanSteps({
  steps,
  title,
  toolName,
  expandKey = "plan",
  defaultOpen,
}: PlanStepsProps) {
  const { current, total } = planProgress(steps)
  const hasRunning = steps.some((s) => s.status === "in_progress")
  const initial =
    defaultOpen !== undefined
      ? defaultOpen
      : hasRunning || steps.some((s) => s.status === "pending")
  const [open, setOpen] = useState(
    () => expansionRemembered.get(expandKey) ?? initial,
  )

  const toggle = () => {
    const next = !open
    expansionRemembered.set(expandKey, next)
    setOpen(next)
  }

  const active =
    steps.find((s) => s.status === "in_progress") ??
    steps.find((s) => s.status === "pending")
  const headTitle =
    title?.trim() ||
    (active ? `Planning: ${active.text}` : total ? "Plan" : "Plan (empty)")
  const stepLabel = total > 0 ? `Step ${current}/${total}` : null

  return (
    <div className={`plan-card ${open ? "open" : ""}`}>
      <button
        type="button"
        className="plan-head"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="plan-caret" aria-hidden>
          {open ? "▼" : "▶"}
        </span>
        <span className="plan-title" title={headTitle}>
          {headTitle}
        </span>
        {stepLabel ? (
          <span className="plan-step-count mono-soft">{stepLabel}</span>
        ) : null}
        {toolName ? <span className="plan-kind">{toolName}</span> : null}
      </button>
      {open ? (
        steps.length === 0 ? (
          <p className="plan-empty">No steps yet.</p>
        ) : (
          <ol className="plan-list">
            {steps.map((step, i) => (
              <li
                key={`${i}-${step.text}`}
                className={`plan-step status-${step.status}`}
              >
                <StepMark status={step.status} />
                <span className="plan-step-text">{step.text}</span>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  )
}

function StepMark({ status }: { status: PlanStepStatus }) {
  if (status === "completed") {
    return (
      <span className="plan-mark done" aria-label="completed" title="completed">
        ✓
      </span>
    )
  }
  if (status === "in_progress") {
    return (
      <span
        className="plan-mark running"
        aria-label="in progress"
        title="in progress"
      >
        ◐
      </span>
    )
  }
  return (
    <span className="plan-mark pending" aria-label="pending" title="pending">
      ○
    </span>
  )
}

/** Map AgentTurnItem plan statuses (`running`) onto PlanStep statuses. */
export function toPlanSteps(
  steps: { text: string; status: string }[] | undefined,
): PlanStep[] {
  if (!steps?.length) return []
  return steps.map((s) => ({
    text: s.text,
    status:
      s.status === "completed"
        ? "completed"
        : s.status === "running" || s.status === "in_progress"
          ? "in_progress"
          : "pending",
  }))
}
