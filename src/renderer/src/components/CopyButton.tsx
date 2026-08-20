import { useEffect, useRef, useState } from "react"

type Phase = "idle" | "done" | "failed"

/**
 * Copies what the caller hands back, not the DOM. `text` is a thunk so a big
 * table is only serialised on the click, never on every render.
 */
export function CopyButton({
  text,
  label = "copy",
  title,
  className = "",
}: {
  text: () => string
  label?: string
  title?: string
  className?: string
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const flash = (next: Phase) => {
    setPhase(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPhase("idle"), 1200)
  }

  return (
    <button
      type="button"
      className={`md-copy ${phase} ${className}`}
      title={title ?? `Copy ${label}`}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard
          .writeText(text())
          .then(() => flash("done"))
          .catch(() => flash("failed"))
      }}
    >
      {phase === "done" ? "copied" : phase === "failed" ? "failed" : label}
    </button>
  )
}
