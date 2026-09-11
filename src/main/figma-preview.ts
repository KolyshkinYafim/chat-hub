import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { figmaLinksInText, parseFigmaUrl, type FigmaPreview } from "@shared/figma-link"

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const CACHE_MS = 10 * 60 * 1000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

type Dependencies = {
  directory: string
  keyForProject: (cwd: string) => Promise<string | null>
  fetch?: typeof fetch
  now?: () => number
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Figma image is too large.")
  if (!response.body) throw new Error("Figma returned an empty response.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new Error("Figma image is too large.")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

export function isFigmaImageUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com") ||
        /^figma(?:-alpha)?-api\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname))
  } catch {
    return false
  }
}

export class FigmaPreviewService {
  private readonly cache = new Map<string, FigmaPreview>()
  private readonly pending = new Map<string, Promise<FigmaPreview>>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  async preview(cwd: string, url: string, scale: 1 | 2 = 1, refresh = false): Promise<FigmaPreview> {
    const node = parseFigmaUrl(url)
    if (!node) throw new Error("Paste a Figma frame link containing node-id.")
    const key = await this.deps.keyForProject(cwd)
    if (!key) throw new Error("Add the Framelink MCP preset and set FIGMA_API_KEY in Settings → MCP.")
    const cacheKey = `${createHash("sha256").update(key).digest("hex")}:${node.fileKey}:${node.nodeId}:${scale}`
    const cached = this.cache.get(cacheKey)
    if (!refresh && cached && this.now() - cached.fetchedAt < CACHE_MS) return cached
    const pending = this.pending.get(cacheKey)
    if (pending) return pending
    const run = this.render(node, key, scale).then((result) => {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, result)
      while (this.cache.size > 12 || [...this.cache.values()].reduce((total, entry) => total + entry.dataUrl.length, 0) > 32 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value as string)
      return result
    }).finally(() => { this.pending.delete(cacheKey) })
    this.pending.set(cacheKey, run)
    return run
  }

  async enrich(cwd: string, text: string, attachments: string[] = []): Promise<{ text: string; attachments: string[]; warning?: string }> {
    const links = figmaLinksInText(text).slice(0, 3)
    if (!links.length) return { text, attachments }
    try {
      if (!await this.deps.keyForProject(cwd)) return { text, attachments }
      const results = await Promise.allSettled(links.map(({ url }) => this.preview(cwd, url, 2)))
      const previews = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
      return {
        text: previews.length ? `${text}\n\n${previews.map((p) => `Figma node ${p.nodeId} in file ${p.fileKey}`).join("\n")}` : text,
        attachments: [...attachments, ...previews.map((p) => p.path)],
        ...(previews.length < links.length ? { warning: "Some Figma previews could not load. Your message was sent with the original links." } : {}),
      }
    } catch {
      return { text, attachments, warning: "Figma preview could not load. Your message was sent with the original link." }
    }
  }

  private async render(node: { fileKey: string; nodeId: string }, key: string, scale: 1 | 2): Promise<FigmaPreview> {
    const signal = AbortSignal.timeout(12_000)
    const endpoint = new URL(`https://api.figma.com/v1/images/${node.fileKey}`)
    endpoint.search = new URLSearchParams({ ids: node.nodeId, format: "png", scale: String(scale) }).toString()
    const response = await this.fetcher(endpoint, { headers: { "X-Figma-Token": key }, signal, redirect: "error" })
    if (!response.ok) throw new Error(response.status === 403 ? "Figma key expired or this file is inaccessible." : `Figma preview unavailable (HTTP ${response.status}).`)
    const payload = JSON.parse((await boundedBody(response, 256 * 1024)).toString("utf8")) as { images?: Record<string, unknown> }
    const imageUrl = payload.images?.[node.nodeId]
    if (typeof imageUrl !== "string" || !isFigmaImageUrl(imageUrl)) throw new Error("Figma could not render this node.")
    const image = await this.fetcher(imageUrl, { signal, redirect: "error" })
    if (!image.ok) throw new Error("Figma image download failed.")
    const png = await boundedBody(image, MAX_IMAGE_BYTES)
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Figma did not return a PNG image.")
    const digest = createHash("sha256").update(png).digest("hex").slice(0, 20)
    const path = join(this.deps.directory, `figma-${node.fileKey}-${node.nodeId.replace(":", "-")}-${digest}.png`)
    await mkdir(this.deps.directory, { recursive: true, mode: 0o700 })
    await writeFile(path, png, { mode: 0o600 })
    return { ...node, path, dataUrl: `data:image/png;base64,${png.toString("base64")}`, fetchedAt: this.now() }
  }
}
