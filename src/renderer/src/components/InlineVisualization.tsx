import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { VisualizationRef } from "../lib/markdown"
import { errorText, surfaceBridge, surfaceBridgeReady } from "../lib/surface-bridge"

const MIN_HEIGHT = 180
const MAX_HEIGHT = 1600

export function relativeVisualizationPath(cwd: string, path: string): string | null {
  const root = cwd.replace(/[\\/]+$/, "")
  const candidate = path.trim()
  if (!candidate) return null
  if (!candidate.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(candidate)) {
    return candidate
  }
  const separators = new Set(["/", "\\"])
  if (!candidate.startsWith(root) || !separators.has(candidate[root.length] ?? "")) {
    return null
  }
  return candidate.slice(root.length + 1)
}

export function InlineVisualization({
  refInfo,
  cwd,
}: {
  refInfo: VisualizationRef
  cwd?: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const token = useId().replace(/:/g, "")
  const [fragment, setFragment] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(360)

  useEffect(() => {
    let active = true
    if (!cwd || !surfaceBridgeReady()) {
      setError("Visualization is unavailable outside a project workspace.")
      return () => { active = false }
    }
    const relPath = relativeVisualizationPath(cwd, refInfo.path)
    if (!relPath) {
      setError("Visualization path is outside the project workspace.")
      return () => { active = false }
    }
    void surfaceBridge().readFileText(cwd, relPath).then((file) => {
      if (!active) return
      if (file.binary || file.truncated) {
        setError("Visualization must be a complete text HTML fragment.")
        return
      }
      setFragment(file.text)
      setError(null)
    }).catch((reason) => {
      if (active) setError(errorText(reason))
    })
    return () => { active = false }
  }, [cwd, refInfo.path])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const payload = event.data as { type?: unknown; token?: unknown; height?: unknown }
      if (payload?.type !== "chathub-visualize-height" || payload.token !== token) return
      if (typeof payload.height !== "number" || !Number.isFinite(payload.height)) return
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(payload.height))))
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [token])

  const srcDoc = useMemo(
    () => fragment === null ? "" : visualizationDocument(fragment, token),
    [fragment, token],
  )

  if (error) {
    return <div className="inline-visualization-error" role="alert">{error}</div>
  }
  if (fragment === null) {
    return <div className="inline-visualization-loading">Loading visualization…</div>
  }
  return (
    <div className={`inline-visualization ${refInfo.wide ? "is-wide" : ""}`}>
      <iframe
        ref={frameRef}
        title={refInfo.title ?? "Interactive visualization"}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ height }}
      />
    </div>
  )
}

function visualizationDocument(fragment: string, token: string): string {
  const safeToken = JSON.stringify(token)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net; font-src https://fonts.gstatic.com https://fonts.bunny.net; img-src data: blob: https:; connect-src 'none'; frame-src 'none'"><style>${BASE_STYLE}</style></head><body>${fragment}<script>${bootstrapScript(safeToken)}</script></body></html>`
}

const BASE_STYLE = `
:root{color-scheme:light dark;--background:light-dark(#fff,#111318);--foreground:light-dark(#17191f,#f4f5f7);--card:light-dark(#f3f4f6,#20232b);--card-foreground:var(--foreground);--muted:light-dark(#e7e8ec,#2b2f38);--muted-foreground:light-dark(#6f7480,#aeb3bd);--primary:light-dark(#17191f,#f4f5f7);--primary-foreground:light-dark(#fff,#17191f);--secondary:var(--muted);--secondary-foreground:var(--foreground);--accent:light-dark(#dcecff,#213754);--accent-foreground:var(--foreground);--destructive:light-dark(#b42318,#ff8a80);--border:light-dark(#d9dce2,#353a45);--input:var(--border);--ring:light-dark(#2684ff,#69a8ff);--blue:#3b82f6;--orange:#f59e0b;--green:#22c55e;--red:#ef4444;--purple:#a855f7;--yellow:#eab308;--viz-series-1:var(--blue);--viz-series-2:var(--orange);--viz-series-3:var(--green);--viz-series-4:var(--purple);--viz-series-5:var(--red);--viz-series-6:var(--yellow);--font-size-base:14px}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--foreground);font:400 var(--font-size-base)/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{padding:12px}h1,h2,h3{font-weight:500;margin:.25rem 0 .5rem}p{margin:.4rem 0 1rem}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--muted);padding:.08rem .3rem;border-radius:5px}.text-muted{color:var(--muted-foreground)}.text-small{font-size:12px}.text-destructive{color:var(--destructive)}.text-end{text-align:end}.text-center{text-align:center}.text-nowrap{white-space:nowrap}.tabular-nums{font-variant-numeric:tabular-nums}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.card{background:var(--card);color:var(--card-foreground);padding:14px;border-radius:14px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.viz-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.viz-stat{display:grid;gap:3px}.viz-stat-value{font-size:1.5rem;font-weight:500}.viz-badge{display:inline-flex;align-items:center;gap:5px;width:max-content;padding:4px 8px;border-radius:999px;background:var(--accent);color:var(--accent-foreground);font-size:12px}.nav{display:flex;gap:4px}.nav-justified>*{flex:1}.nav-link,.btn{appearance:none;border:0;border-radius:9px;padding:8px 12px;background:transparent;color:var(--foreground);font:inherit;cursor:pointer}.nav-link.active,.btn[aria-pressed="true"],.is-selected{background:var(--primary);color:var(--primary-foreground)}.btn{background:var(--secondary);color:var(--secondary-foreground)}.btn-primary{background:var(--primary);color:var(--primary-foreground)}.btn-ghost{background:transparent}.viz-tile{min-height:44px}.viz-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.form-label{display:grid;gap:5px}.form-control,.form-select{border:1px solid var(--input);border-radius:8px;padding:8px;background:var(--background);color:var(--foreground);font:inherit}.progress{height:8px;border-radius:999px;background:var(--muted);overflow:hidden}.progress-bar{height:100%;background:var(--viz-series-1)}.table-responsive{overflow-x:auto}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;padding:8px;border-bottom:1px solid var(--border)}hr{border:0;border-top:1px solid var(--border);margin:1rem 0}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--ring);outline-offset:2px}i[data-lucide]{display:inline-block;width:1em;height:1em}
@media(max-width:420px){body{padding:8px}.viz-grid{grid-template-columns:1fr}.nav-link,.btn{padding:10px 8px}}
`

function bootstrapScript(token: string): string {
  return `(()=>{const sendHeight=()=>parent.postMessage({type:"chathub-visualize-height",token:${token},height:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)},"*");document.querySelectorAll('[role="tab"]').forEach(tab=>tab.addEventListener("click",()=>{const list=tab.closest('[role="tablist"]');if(!list)return;list.querySelectorAll('[role="tab"]').forEach(item=>{const selected=item===tab;item.classList.toggle("active",selected);item.setAttribute("aria-selected",String(selected));const panel=document.getElementById(item.getAttribute("aria-controls")||"");if(panel)panel.hidden=!selected});sendHeight()}));new ResizeObserver(sendHeight).observe(document.body);addEventListener("load",sendHeight);requestAnimationFrame(sendHeight)})();`
}
