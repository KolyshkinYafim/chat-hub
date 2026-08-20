import { useEffect, useId, useState } from "react"
import { CopyButton } from "./CopyButton"

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string }

let mermaidReady: Promise<typeof import("mermaid")> | null = null

function loadMermaid() {
  if (!mermaidReady) mermaidReady = import("mermaid")
  return mermaidReady
}

/** Bumps whenever the theme editor rewrites the root tokens, so diagrams follow. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setVersion((n) => n + 1))
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class"] })
    return () => observer.disconnect()
  }, [])
  return version
}

function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return true
  const digits = hex[1]!
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}

/**
 * Mermaid draws with its own palette unless every colour is handed to it, so
 * the live theme tokens are read off `:root` and passed through on each render.
 */
function themeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback

  const bg = token("--code-bg", "#12141a")
  const surface = token("--bg-active", "#1e2028")
  const border = token("--border", "#2a2c35")
  const text = token("--text", "#ececf1")
  const muted = token("--text-muted", "#8b8d98")
  const accent = token("--accent", "#7c8cff")

  return {
    darkMode: String(isDark(bg)),
    background: bg,
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: token("--bg-elevated", "#16171c"),
    tertiaryColor: token("--bg-hover", "#1a1b21"),
    secondaryTextColor: text,
    tertiaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
    lineColor: muted,
    textColor: text,
    mainBkg: surface,
    nodeBorder: border,
    nodeTextColor: text,
    clusterBkg: token("--bg-elevated", "#16171c"),
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: bg,
    labelBackground: bg,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: border,
    labelTextColor: text,
    actorBkg: surface,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: muted,
    signalColor: text,
    signalTextColor: text,
    loopTextColor: text,
    noteBkgColor: token("--bg-hover", "#1a1b21"),
    noteBorderColor: border,
    noteTextColor: text,
    activationBkgColor: accent,
    activationBorderColor: border,
    sequenceNumberColor: bg,
    altBackground: token("--bg-elevated", "#16171c"),
    classText: text,
    attributeBackgroundColorOdd: token("--bg-elevated", "#16171c"),
    attributeBackgroundColorEven: surface,
    fillType0: surface,
    fillType1: token("--bg-elevated", "#16171c"),
    fillType2: token("--bg-hover", "#1a1b21"),
    fillType3: token("--bg-row-active", "#252730"),
    pie1: accent,
    pie2: token("--ok", "#3dd68c"),
    pie3: token("--waiting", "#f0b429"),
    pie4: token("--danger", "#f07178"),
    pie5: token("--accent-2", "#5b8def"),
    pie6: token("--working", "#4d9fff"),
    pieTitleTextColor: text,
    pieSectionTextColor: bg,
    pieLegendTextColor: text,
    pieStrokeColor: border,
    pieOuterStrokeColor: border,
    taskBkgColor: surface,
    taskBorderColor: border,
    taskTextColor: text,
    taskTextOutsideColor: text,
    taskTextLightColor: text,
    taskTextDarkColor: bg,
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    doneTaskBkgColor: token("--ok", "#3dd68c"),
    doneTaskBorderColor: border,
    critBkgColor: token("--danger", "#f07178"),
    critBorderColor: border,
    gridColor: border,
    sectionBkgColor: token("--bg-elevated", "#16171c"),
    sectionBkgColor2: surface,
    altSectionBkgColor: bg,
    todayLineColor: token("--waiting", "#f0b429"),
    fontFamily: token(
      "--font",
      '"SF Pro Text", "Inter", system-ui, -apple-system, sans-serif',
    ),
  }
}

/**
 * Lazy Mermaid renderer for transcript fences. Callers must only mount this
 * once the message is final — partial stream chunks are invalid mermaid.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, "")
  const theme = useThemeVersion()
  const [state, setState] = useState<RenderState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const renderId = `mmd-${reactId}-${Math.random().toString(36).slice(2, 9)}`

    setState({ status: "loading" })

    void (async () => {
      try {
        const mod = await loadMermaid()
        const mermaid = mod.default
        // LLM output is untrusted — strict blocks click/script injection, and
        // re-initialising here is what lets a theme switch repaint the diagram.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: themeVariables(),
        })
        // parse first so invalid syntax fails before render mutates the DOM.
        await mermaid.parse(code)
        const { svg } = await mermaid.render(renderId, code)
        if (!cancelled) setState({ status: "ready", svg })
      } catch (err) {
        if (cancelled) return
        const message =
          err instanceof Error ? err.message : "Failed to render diagram"
        setState({ status: "error", message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, reactId, theme])

  if (state.status !== "ready") {
    const failed = state.status === "error"
    return (
      <div
        className={`md-block md-mermaid-fallback ${failed ? "failed" : ""}`}
        aria-busy={failed ? undefined : true}
        role={failed ? "note" : undefined}
      >
        <div className="md-block-bar">
          <span className="md-block-tag">mermaid</span>
          {failed ? (
            <span className="md-block-note" title={state.message}>
              could not be drawn — showing source
            </span>
          ) : null}
          <span className="md-block-actions">
            <CopyButton text={() => code} title="Copy the diagram source" />
          </span>
        </div>
        <pre className="md-code">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="md-block md-mermaid">
      <div className="md-block-bar">
        <span className="md-block-tag">diagram</span>
        <span className="md-block-actions">
          <CopyButton text={() => code} title="Copy the diagram source" />
        </span>
      </div>
      {/* SVG is produced by mermaid with securityLevel: "strict" — the only
          intentionally trusted HTML injection path in the renderer. */}
      <div
        className="md-mermaid-canvas"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </div>
  )
}
