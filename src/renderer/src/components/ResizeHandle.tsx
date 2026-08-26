import { useCallback, useRef, type PointerEvent } from "react"
import { widthKeyCommand } from "../lib/shell-size"

type Props = {
  className: string
  /** Announced name, e.g. "Resize sidebar". */
  label: string
  width: number
  min: number
  max: number
  defaultWidth: number
  /** Which arrow key widens this panel — see `widthKeyCommand`. */
  growKey: "ArrowLeft" | "ArrowRight"
  /** Pointer position to the width it implies, before clamping. */
  widthAt: (clientX: number) => number
  clamp: (px: number) => number
  onWidth: (width: number) => void
  onCommit: (width: number) => void
}

/**
 * The ARIA window-splitter pattern: drag with a pointer, nudge with the arrow
 * keys (Shift for a coarse step, Home/End for the limits), and double-click or
 * Enter to go back to the default.
 */
export function ResizeHandle({
  className,
  label,
  width,
  min,
  max,
  defaultWidth,
  growKey,
  widthAt,
  clamp,
  onWidth,
  onCommit,
}: Props) {
  const widthRef = useRef(width)
  widthRef.current = width

  const startResize = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const move = (ev: globalThis.PointerEvent) => {
        const next = clamp(widthAt(ev.clientX))
        widthRef.current = next
        onWidth(next)
      }
      const stop = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", stop)
        handle.removeEventListener("pointercancel", stop)
        onCommit(widthRef.current)
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", stop)
      handle.addEventListener("pointercancel", stop)
    },
    [clamp, onCommit, onWidth, widthAt],
  )

  const reset = useCallback(() => {
    const next = clamp(defaultWidth)
    onWidth(next)
    onCommit(next)
  }, [clamp, defaultWidth, onCommit, onWidth])

  return (
    <div
      className={className}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      title={`${label} — drag, arrow keys, or double-click to reset`}
      onPointerDown={startResize}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const command = widthKeyCommand(e.key, e.shiftKey, growKey)
        if (!command) return
        e.preventDefault()
        if (command.kind === "reset") {
          reset()
          return
        }
        const target =
          command.kind === "delta"
            ? width + command.px
            : command.kind === "min"
              ? min
              : max
        const next = clamp(target)
        onWidth(next)
        onCommit(next)
      }}
    />
  )
}
