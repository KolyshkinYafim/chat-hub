import { readFile } from "node:fs/promises"
import { ipcMain } from "electron"
import { IpcChannels } from "@shared/ipc"
import { DEFAULT_LANGFUSE, type LangfuseConfig, type LangfusePatch, type LangfuseStatus } from "@shared/langfuse"
import { writeFileAtomic } from "./atomic-write"
import { encryptionAvailable, openSecret, sealSecret } from "./secret"
import { LangfuseExporter, normalizeLangfuseUrl } from "./langfuse-exporter"

type Stored = LangfuseConfig & { publicKey: string; secretKey: string }
export class LangfuseService {
  private config: Stored = { ...DEFAULT_LANGFUSE, publicKey: "", secretKey: "" }
  private writes: Promise<unknown> = Promise.resolve()
  readonly exporter = new LangfuseExporter(() => this.credentials())
  constructor(private readonly path: string) {}
  private credentials(): Stored { return { ...this.config, publicKey: openSecret(this.config.publicKey), secretKey: openSecret(this.config.secretKey) } }
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown
      this.config = this.validate(raw, this.config, true)
    } catch { /* Missing/invalid config leaves export disabled. */ }
    this.exporter.start()
  }
  status(): LangfuseStatus {
    const { publicKey, secretKey, ...config } = this.credentials()
    return { ...config, hasPublicKey: Boolean(publicKey), hasSecretKey: Boolean(secretKey), pending: this.exporter.pending, lastError: this.exporter.lastError, lastSentAt: this.exporter.lastSentAt }
  }
  private validate(raw: unknown, previous: Stored, stored = false): Stored {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Langfuse settings")
    const p = raw as Record<string, unknown>
    const next = { ...previous }
    for (const key of ["enabled", "metadataOnly"] as const) {
      if (p[key] !== undefined) { if (typeof p[key] !== "boolean") throw new Error(`Invalid ${key}`); next[key] = p[key] }
    }
    if (p.baseUrl !== undefined) { if (typeof p.baseUrl !== "string") throw new Error("Invalid base URL"); next.baseUrl = normalizeLangfuseUrl(p.baseUrl) }
    if (p.excludedProjects !== undefined) {
      if (!Array.isArray(p.excludedProjects) || p.excludedProjects.length > 1000 || p.excludedProjects.some((x) => typeof x !== "string" || x.length > 4096)) throw new Error("Invalid excluded projects")
      next.excludedProjects = [...new Set(p.excludedProjects as string[])]
    }
    for (const key of ["publicKey", "secretKey"] as const) {
      if (p[key] === undefined) continue
      if (typeof p[key] !== "string" || p[key].length > 8192) throw new Error("Invalid API key")
      const value = p[key].trim()
      if (!stored && value && !encryptionAvailable()) throw new Error("OS keychain encryption is unavailable. Keys were not saved.")
      next[key] = stored || !value ? value : sealSecret(value)
    }
    return next
  }
  update(patch: LangfusePatch): Promise<LangfuseStatus> {
    const write = this.writes.then(async () => {
      const next = this.validate(patch, this.config)
      await writeFileAtomic(this.path, JSON.stringify(next, null, 2))
      this.config = next
      this.exporter.clear()
      return this.status()
    })
    this.writes = write.catch(() => {})
    return write
  }
  async testConnection(): Promise<string> {
    const c = this.credentials()
    if (!c.publicKey || !c.secretKey) throw new Error("Save both API keys first.")
    const response = await fetch(`${c.baseUrl}/api/public/projects`, {
      redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Basic ${Buffer.from(`${c.publicKey}:${c.secretKey}`).toString("base64")}` },
    })
    if (!response.ok) throw new Error(`Connection failed: HTTP ${response.status}`)
    return "Connected. Project credentials verified."
  }
  register(): void {
    ipcMain.handle(IpcChannels.langfuseGet, () => this.status())
    ipcMain.handle(IpcChannels.langfuseUpdate, (_event, patch: LangfusePatch) => this.update(patch))
    ipcMain.handle(IpcChannels.langfuseTest, () => this.testConnection())
  }
}
