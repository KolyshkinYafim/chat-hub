export type FigmaNode = { fileKey: string; nodeId: string }

export function parseFigmaUrl(input: string): FigmaNode | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname) || url.port || url.username || url.password) return null
    const match = /^\/(?:design|file)\/([a-zA-Z0-9]+)(?:\/|$)/.exec(url.pathname)
    const rawNode = url.searchParams.get("node-id")
    if (!match || !rawNode || !/^\d+[:-]\d+$/.test(rawNode)) return null
    return { fileKey: match[1], nodeId: rawNode.replace("-", ":") }
  } catch {
    return null
  }
}

export function figmaLinksInText(text: string): { url: string; node: FigmaNode }[] {
  const seen = new Set<string>()
  const links: { url: string; node: FigmaNode }[] = []
  for (const match of text.matchAll(/https:\/\/(?:www\.)?figma\.com\/[^\s<>"'`]+/g)) {
    const url = match[0].replace(/[),.;!?]+$/, "")
    const node = parseFigmaUrl(url)
    if (!node) continue
    const id = `${node.fileKey}:${node.nodeId}`
    if (seen.has(id)) continue
    seen.add(id)
    links.push({ url, node })
  }
  return links
}

export function figmaAssetsPrompt(url: string, directory: string, tokensFile: string): string {
  if (!parseFigmaUrl(url)) throw new Error("Paste a Figma frame link containing node-id.")
  if (!directory.trim() || !tokensFile.trim()) throw new Error("Enter an asset folder and tokens file.")
  return `Using the Figma MCP for ${url.trim()}: export every icon/vector in the selection as SVG into ${directory.trim()}, export variables as CSS custom properties into ${tokensFile.trim()}, and match existing naming in that folder. Inspect the project first and preserve existing assets and unrelated tokens. Report the files created or updated.`
}

export type FigmaPreview = FigmaNode & { path: string; dataUrl: string; fetchedAt: number }
