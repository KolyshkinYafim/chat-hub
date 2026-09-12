import { useEffect, useState } from "react"
import type { LiveStep, PlanProgress } from "../lib/live-step"
import { formatElapsed, stepPhase, stepPhaseLabel } from "../lib/live-step"

export type LiveStepTickerProps = {
  step: LiveStep
  plan: PlanProgress | null
  onJump: () => void
}

export function LiveStepTicker({ step, plan, onJump }: LiveStepTickerProps) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [step.key])

  // "Testing · Shell", but never "Thinking · Thinking" or "Running a tool · Bash":
  // the phase only earns its place when it says more than the step does.
  const phase = step.kind === "tool" && step.phase && step.phase !== "working"
    ? stepPhaseLabel(step)
    : null

  return (
    <button
      type="button"
      className={`live-ticker${step.phase ? ` phase-${step.phase}` : ""}`}
      onClick={onJump}
      title="Scroll to the live card"
      aria-live="polite"
    >
      <span className={`orb ${stepPhase(step)}`} aria-hidden />
      {phase ? <span className="live-ticker-phase">{phase} ·</span> : null}
      <span
        className="live-ticker-label"
        title={step.server ?? undefined}
      >
        {step.label}
      </span>
      {step.detail ? (
        <span className="live-ticker-detail">· {step.detail}</span>
      ) : null}
      <span className="live-ticker-elapsed">· {formatElapsed(elapsedMs)}</span>
      {plan ? (
        <span className="live-ticker-plan">
          <span className="live-ticker-plan-count">
            {plan.done}/{plan.total}
          </span>
          {plan.active ? (
            <span className="live-ticker-plan-active">{plan.active}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}
