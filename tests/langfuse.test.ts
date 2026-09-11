import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_LANGFUSE } from "../src/shared/langfuse"
import { LangfuseExporter, normalizeLangfuseUrl, turnSpan } from "../src/main/langfuse-exporter"
import type { ChatMessage, SessionMeta } from "../src/shared/types"
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(`sealed:${v}`), decryptString: (v: Buffer) => v.toString().slice(7) } }))
import { safeStorage } from "electron"
import { LangfuseService } from "../src/main/langfuse"
const session: SessionMeta = { id: "s1", title: "Private title", project: "demo", provider: "claude", model: "test-model", cwd: "/repo", status: "done", createdAt: 100, updatedAt: 300 }
const messages: ChatMessage[] = [
  { id: "u", sessionId: "s1", role: "user", content: "private prompt", createdAt: 100, attachments: [{ path: "/secret.txt", name: "secret", sizeBytes: 10, kind: "file" }] },
  { id: "a", sessionId: "s1", role: "assistant", content: "answer", createdAt: 150, usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.1 }, items: [{ id: "tool", kind: "error", status: "failed", message: "secret tool output" }] },
  { id: "next", sessionId: "s1", role: "user", content: "queued question", createdAt: 200 },
]
afterEach(() => vi.useRealTimers())
describe("Langfuse trace shaping", () => {
  it("exports metadata without user text, title, files or tool output", () => {
    const span = turnSpan(session, messages, "u", false, true, 300)!
    const text = JSON.stringify(span)
    for (const value of ["private prompt", "Private title", "answer", "/secret.txt", "secret tool output"]) expect(text).not.toContain(value)
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(span.startTimeUnixNano).toBe("100000000")
    expect(text).toContain("usage_details")
  })
  it("includes only this prompt and final reply when text is enabled", () => {
    const span = turnSpan(session, messages, "u", true, false, 300)!
    const text = JSON.stringify(span)
    expect(text).toContain("private prompt"); expect(text).toContain("answer")
    expect(text).not.toContain("queued question"); expect(text).not.toContain("secret tool output")
    expect(span.status.code).toBe(2)
  })
  it("rejects unsafe endpoints and permits local self-hosting", () => {
    for (const url of ["http://example.com", "https://a:b@example.com", "https://host/?key=secret", "file:///tmp/x"]) expect(() => normalizeLangfuseUrl(url)).toThrow()
    expect(normalizeLangfuseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000")
  })
})
describe("Langfuse transport", () => {
  it("does no work when off or when the project opts out", async () => {
    const request = vi.fn()
    const config = { ...DEFAULT_LANGFUSE, publicKey: "pub", secretKey: "secret" }
    const exporter = new LangfuseExporter(() => config, request)
    exporter.enqueue(session, messages, "u", false)
    config.enabled = true; config.excludedProjects = ["/repo"]
    exporter.enqueue(session, messages, "u", false)
    await exporter.flush(); expect(request).not.toHaveBeenCalled()
  })
  it("batches spans over OTLP JSON with auth and flushes on the timer", async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    const exporter = new LangfuseExporter(() => ({ ...DEFAULT_LANGFUSE, enabled: true, publicKey: "pub", secretKey: "secret" }), request)
    exporter.start(); exporter.enqueue(session, messages, "u", false)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, opts] = request.mock.calls[0]
    expect(url).toContain("/api/public/otel/v1/traces")
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from("pub:secret").toString("base64")}`)
    expect(opts.redirect).toBe("error")
    expect(JSON.parse(opts.body).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
    expect(exporter.pending).toBe(0)
    await exporter.stop()
  })
  it("bounds retries and discards after three failed attempts", async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockRejectedValue(new Error("offline"))
    const exporter = new LangfuseExporter(() => ({ ...DEFAULT_LANGFUSE, enabled: true, publicKey: "pub", secretKey: "secret" }), request)
    exporter.start(); exporter.enqueue(session, messages, "u", false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledTimes(3); expect(exporter.pending).toBe(0)
    expect(exporter.lastError).toBe("offline"); await exporter.stop()
  })
  it("does not duplicate partially accepted batches", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ partialSuccess: { rejectedSpans: "1" } })))
    const exporter = new LangfuseExporter(() => ({ ...DEFAULT_LANGFUSE, enabled: true, publicKey: "pub", secretKey: "secret" }), request)
    exporter.enqueue(session, messages, "u", false); await exporter.flush(); await exporter.flush()
    expect(request).toHaveBeenCalledTimes(1); expect(exporter.lastError).toContain("part")
  })
})
it("stores sealed keys, never returns them, and preserves them across config edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "langfuse-test-"))
  const path = join(dir, "tracing.json")
  const service = new LangfuseService(path)
  try {
    await service.load()
    const status = await service.update({ publicKey: "public", secretKey: "private", enabled: true })
    expect(status.hasSecretKey).toBe(true); expect(status).not.toHaveProperty("secretKey")
    const raw = await readFile(path, "utf8"); expect(raw).not.toContain('"private"'); expect(raw).toContain("enc:v1:")
    await service.update({ metadataOnly: false })
    expect(service.status().hasSecretKey).toBe(true)
    await expect(service.update({ baseUrl: "http://remote.test" })).rejects.toThrow()
    await service.update({ enabled: false, secretKey: "", publicKey: "" })
    expect(service.status().hasSecretKey).toBe(false)
  } finally { await service.exporter.stop(); await rm(dir, { recursive: true, force: true }) }
})

it("rejects encryption failure without saving plaintext or replacing prior keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "langfuse-key-failure-"))
  const path = join(dir, "tracing.json")
  const service = new LangfuseService(path)
  try {
    await service.load()
    await service.update({ publicKey: "original-public", secretKey: "original-secret" })
    const saved = await readFile(path, "utf8")
    expect(safeStorage.isEncryptionAvailable()).toBe(true)
    const encrypt = vi.spyOn(safeStorage, "encryptString").mockImplementation(() => { throw new Error("keychain locked") })
    try {
      await expect(service.update({ secretKey: "replacement-secret" })).rejects.toThrow("OS keychain encryption failed")
      expect(await readFile(path, "utf8")).toBe(saved)
      expect(service.status().hasSecretKey).toBe(true)
      expect(saved).not.toContain("plain:v1:")
    } finally { encrypt.mockRestore() }
    await service.update({ metadataOnly: false })
    expect(service.status().metadataOnly).toBe(false)
    expect(service.status().hasSecretKey).toBe(true)
  } finally { await service.exporter.stop(); await rm(dir, { recursive: true, force: true }) }
})
