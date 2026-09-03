import { useEffect, useState } from "react"
import type { LiveStep, PlanProgress } from "../lib/live-step"
import { formatElapsed, stepPhase } from "../lib/live-step"

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

  return (
    <button
      type="button"
      className="live-ticker"
      onClick={onJump}
      title="Scroll to the live card"
      aria-live="polite"
    >
      <span className={`orb ${stepPhase(step)}`} aria-hidden />
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
