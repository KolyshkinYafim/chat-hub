import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import {
  errorText,
  surfaceBridge,
  type TerminalChunk,
} from "../../lib/surface-bridge"

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value === "" ? fallback : value
}

type Props = {
  cwd: string
}

export function TerminalSurface({ cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: cssVar("--mono", "ui-monospace, Menlo, monospace"),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: cssVar("--code-bg", "#12141a"),
        foreground: cssVar("--text", "#ececf1"),
        cursor: cssVar("--accent", "#7c8cff"),
        cursorAccent: cssVar("--code-bg", "#12141a"),
        selectionBackground: cssVar("--bg-row-active", "#252730"),
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const bridge = surfaceBridge()
    let ptyId: string | null = null
    let disposed = false
    let exited = false
    const early: TerminalChunk[] = []

    const offData = bridge.onTerminalData((chunk) => {
      if (ptyId === null) {
        early.push(chunk)
        return
      }
      if (chunk.ptyId === ptyId) term.write(chunk.data)
    })

    const offExit = bridge.onTerminalExit((exit) => {
      if (exit.ptyId !== ptyId) return
      exited = true
      setStatus(`Shell exited (${exit.exitCode})`)
    })

    const onInput = term.onData((data) => {
      if (ptyId !== null && !exited) bridge.termWrite(ptyId, data)
    })

    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (ptyId !== null && !exited) {
        bridge.termResize(ptyId, term.cols, term.rows)
      }
    })
    observer.observe(host)

    void bridge
      .termStart(cwd, term.cols, term.rows)
      .then((started) => {
        if (disposed) {
          bridge.termKill(started.ptyId)
          return
        }
        ptyId = started.ptyId
        for (const chunk of early) {
          if (chunk.ptyId === ptyId) term.write(chunk.data)
        }
        early.length = 0
        term.focus()
      })
      .catch((err: unknown) => {
        if (!disposed) setStatus(errorText(err))
      })

    return () => {
      disposed = true
      observer.disconnect()
      onInput.dispose()
      offData()
      offExit()
      if (ptyId !== null && !exited) bridge.termKill(ptyId)
      term.dispose()
    }
  }, [cwd])

  return (
    <div className="surface-terminal">
      <div className="surface-terminal-host" ref={hostRef} />
      {status ? <div className="surface-terminal-status">{status}</div> : null}
    </div>
  )
}
