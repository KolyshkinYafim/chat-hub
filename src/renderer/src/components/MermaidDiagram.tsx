import { useEffect, useId, useState } from "react"

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string }

let mermaidReady: Promise<typeof import("mermaid")> | null = null

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(async (mod) => {
      const mermaid = mod.default
      // LLM output is untrusted — strict blocks click/script injection in diagrams.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        themeVariables: {
          darkMode: true,
          background: "#12141a",
          primaryColor: "#1e2028",
          primaryTextColor: "#ececf1",
          primaryBorderColor: "#2a2c35",
          secondaryColor: "#16171c",
          tertiaryColor: "#1a1b21",
          lineColor: "#8b8d98",
          textColor: "#ececf1",
          mainBkg: "#1e2028",
          nodeBorder: "#2a2c35",
          clusterBkg: "#16171c",
          titleColor: "#ececf1",
          edgeLabelBackground: "#12141a",
          fontFamily:
            '"SF Pro Text", "Inter", system-ui, -apple-system, sans-serif',
        },
      })
      return mod
    })
  }
  return mermaidReady
}

/**
 * Lazy Mermaid renderer for transcript fences. Callers must only mount this
 * once the message is final — partial stream chunks are invalid mermaid.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, "")
  const [state, setState] = useState<RenderState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const renderId = `mmd-${reactId}-${Math.random().toString(36).slice(2, 9)}`

    setState({ status: "loading" })

    void (async () => {
      try {
        const mod = await loadMermaid()
        const mermaid = mod.default
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
  }, [code, reactId])

  if (state.status === "loading") {
    return (
      <div className="md-mermaid md-mermaid-loading" aria-busy="true">
        <span className="md-code-lang">mermaid</span>
        <pre className="md-mermaid-source">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="md-mermaid md-mermaid-error" role="alert">
        <div className="md-mermaid-error-msg">{state.message}</div>
        <pre className="md-code">
          <span className="md-code-lang">mermaid</span>
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  // SVG is produced by mermaid with securityLevel: "strict" — the only
  // intentionally trusted HTML injection path in the renderer.
  return (
    <div
      className="md-mermaid"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  )
}
