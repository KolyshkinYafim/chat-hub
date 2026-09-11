import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { figmaAssetsPrompt, figmaLinksInText, parseFigmaUrl } from "@shared/figma-link"
import { FigmaPreviewService, isFigmaImageUrl } from "../src/main/figma-preview"

const FRAME_URL = "https://www.figma.com/design/AbC123/My-Design?node-id=1-2"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9b8AAAAASUVORK5CYII=", "base64")
const IMAGE = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/frame.png?signature=secret"
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })

describe("Figma links", () => {
  it.each([FRAME_URL, "https://figma.com/file/AbC123/Title?node-id=1%3A2", "https://figma.com/design/AbC123?node-id=1:2"])("parses a frame URL %s", (url) => {
    expect(parseFigmaUrl(url)).toEqual({ fileKey: "AbC123", nodeId: "1:2" })
  })
  it.each(["https://figma.com.evil.test/design/AbC123?node-id=1-2", "http://figma.com/design/A?node-id=1-2", "https://user@figma.com/design/A?node-id=1-2", "https://figma.com/design/A?node-id=x", "https://figma.com/design/A", "https://figma.com/proto/A?node-id=1-2", "https://figma.com:8080/design/A?node-id=1-2"])("rejects %s", (url) => {
    expect(parseFigmaUrl(url)).toBeNull()
  })
  it("extracts and deduplicates markdown links", () => {
    expect(figmaLinksInText(`See [frame](${FRAME_URL}), and ${FRAME_URL}.`)).toEqual([{ url: FRAME_URL, node: { fileKey: "AbC123", nodeId: "1:2" } }])
  })
  it("builds an editable asset prompt", () => {
    expect(figmaAssetsPrompt(FRAME_URL, "icons", "tokens.css")).toContain("SVG into icons, export variables as CSS custom properties into tokens.css")
    expect(() => figmaAssetsPrompt("bad", "icons", "tokens")).toThrow("frame link")
  })
})

async function setup(hasKey = true) {
  const directory = await mkdtemp(join(tmpdir(), "figma-preview-"))
  folders.push(directory)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    return (input instanceof Request ? input.url : input.toString()).startsWith("https://api.figma.com/")
      ? Response.json({ images: { "1:2": IMAGE } })
      : new Response(PNG)
  })
  let now = 1000
  const keyForProject = vi.fn(async () => hasKey ? "sealed-key" : null)
  const service = new FigmaPreviewService({ directory, fetch: fetcher, keyForProject, now: () => now })
  return { service, fetcher, keyForProject, advance: () => { now += 600_001 } }
}

describe("Figma previews", () => {
  it("stores PNGs, caches, refreshes and sends the token only to the API", async () => {
    const { service, fetcher, advance } = await setup()
    const first = await service.preview("/project", FRAME_URL)
    expect(await readFile(first.path)).toEqual(PNG)
    expect(first.dataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`)
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ "X-Figma-Token": "sealed-key" })
    expect(fetcher.mock.calls[1][1]?.headers).toBeUndefined()
    expect((fetcher.mock.calls[0][0] as globalThis.URL).href).toContain("ids=1%3A2&format=png&scale=1")
    await service.preview("/project", FRAME_URL)
    expect(fetcher).toHaveBeenCalledTimes(2)
    advance()
    await service.preview("/project", FRAME_URL)
    await service.preview("/project", FRAME_URL, 1, true)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it("deduplicates simultaneous loads and separates scales", async () => {
    const { service, fetcher } = await setup()
    await Promise.all([service.preview("/project", FRAME_URL), service.preview("/project", FRAME_URL)])
    expect(fetcher).toHaveBeenCalledTimes(2)
    await service.preview("/project", FRAME_URL, 2)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it("injects preview paths and node identity while preserving user attachments", async () => {
    const { service } = await setup()
    const result = await service.enrich("/project", `Build ${FRAME_URL}`, ["/original.png"])
    expect(result.text).toContain("Figma node 1:2 in file AbC123")
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0]).toBe("/original.png")
    expect(result.warning).toBeUndefined()
  })
  it("does no network work without a key and degrades errors to links", async () => {
    const noKey = await setup(false)
    expect(await noKey.service.enrich("/project", FRAME_URL)).toEqual({ text: FRAME_URL, attachments: [] })
    expect(noKey.fetcher).not.toHaveBeenCalled()
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValue(new Response("denied", { status: 403 }))
    expect(await service.enrich("/project", FRAME_URL)).toMatchObject({ text: FRAME_URL, attachments: [], warning: expect.any(String) })
  })
  it.each(["http://127.0.0.1/image.png", "https://evil.test/image.png", "https://figma.com.evil.test/img", "https://figma-api.s3.amazonaws.com.evil.test/img"])("blocks untrusted image destinations %s", async (url) => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValue(Response.json({ images: { "1:2": url } }))
    await expect(service.preview("/project", FRAME_URL)).rejects.toThrow("could not render")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(isFigmaImageUrl(url)).toBe(false)
  })
  it("rejects non-PNG data and oversized bodies", async () => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(Response.json({ images: { "1:2": IMAGE } })).mockResolvedValueOnce(new Response("<html>bad</html>"))
    await expect(service.preview("/project", FRAME_URL)).rejects.toThrow("PNG")
    fetcher.mockResolvedValueOnce(Response.json({ images: { "1:2": IMAGE } })).mockResolvedValueOnce(new Response(PNG, { headers: { "content-length": String(21 * 1024 * 1024) } }))
    await expect(service.preview("/project", FRAME_URL)).rejects.toThrow("too large")
  })
})
