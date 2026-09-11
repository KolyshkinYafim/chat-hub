import type { TurnOutcome } from "../lib/turn-outcome"

/**
 * The live ticker's counterpart for a chat at rest: one line above the
 * composer that says the turn is over (or waiting, or cut, or failed), what
 * it cost, and what the reader can do next — so silence never reads as
 * "the agent stopped answering".
 */
export function TurnOutcomeStrip({
  outcome,
  onJump,
}: {
  outcome: TurnOutcome
  onJump: (messageId: string) => void
}) {
  return (
    <button
      type="button"
      className={`turn-outcome is-${outcome.tone}`}
      onClick={() => outcome.messageId && onJump(outcome.messageId)}
      title="Scroll to the last turn"
    >
      <span className="turn-outcome-dot" aria-hidden />
      <span className="turn-outcome-label">{outcome.label}</span>
      {outcome.facts.map((fact) => (
        <span key={fact} className="turn-outcome-fact">
          · {fact}
        </span>
      ))}
      <span className="turn-outcome-hint">— {outcome.hint}</span>
    </button>
  )
}
