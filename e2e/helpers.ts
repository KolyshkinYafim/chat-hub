import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { redactSensitive } from "../src/main/main-log"
import type { ChatMessage } from "../src/shared/types"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  _electron as electron,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test"
import { sessionMetas, writeSeedData } from "./seed.mjs"

export type SeedSession = {
  id: string
  title: string
  project?: string
  status?: string
  archived?: boolean
}

export type LaunchedApp = {
  app: ElectronApplication
  page: Page
  userData: string
  workDir: string
  mainOutput: string[]
}

const ROOT = resolve(__dirname, "..")

export async function launchApp(
  sessions: readonly SeedSession[] = [],
  messages: Record<string, ChatMessage[]> = {},
): Promise<LaunchedApp> {
  const userData = await mkdtemp(join(tmpdir(), "chat-hub-e2e-"))
  const workDir = await realpath(await mkdtemp(join(tmpdir(), "chat-hub-work-")))
  const now = Date.now()
  const metas = sessionMetas(sessions, workDir, now)
  await writeSeedData(userData, metas, workDir, now)
  for (const [id, turns] of Object.entries(messages)) {
    if (!sessions.some(session => session.id === id)) throw new Error("Messages require a seeded session")
    await writeFile(join(userData, "data", "sessions", id, "hot.json"), JSON.stringify(turns))
  }

  const app = await electron.launch({
    ...(process.env.CHAT_HUB_E2E_EXECUTABLE ? { executablePath: process.env.CHAT_HUB_E2E_EXECUTABLE } : {}),
    args: process.env.CHAT_HUB_E2E_EXECUTABLE ? [] : [join(ROOT, "out", "main", "index.js")],
    cwd: ROOT,
    env: {
      ...process.env,
      CHAT_HUB_USER_DATA: userData,
      AGENT_DESKTOP_EVENTS: join(userData, "agent-desktop", "events.jsonl"),
      AGENT_DESKTOP_COMMANDS: join(userData, "agent-desktop", "commands.jsonl"),
      AGENT_DESKTOP_SOCKET: "",
      CHAT_HUB_SOCKET: "",
      CHATHUB_BROWSER_SOCKET: "",
      CHAT_HUB_SELFTEST: "0",
      CHAT_HUB_DEMO: "0",
      CHAT_HUB_COCKPIT: "0",
      ELECTRON_ENABLE_LOGGING: "1",
    },
  })
  const mainOutput: string[] = []
  app.process().stderr?.on("data", chunk => {
    mainOutput.push(redactSensitive(String(chunk)))
    if (mainOutput.length > 200) mainOutput.shift()
  })
  const page = await app.firstWindow()
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  await page.waitForLoadState("domcontentloaded")
  return { app, page, userData, workDir, mainOutput }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  const info = test.info()
  try {
    await info.attach("main-process", { body: launched.mainOutput.join(""), contentType: "text/plain" })
    const screenshot = info.outputPath("desktop.png")
    await launched.page.screenshot({ path: screenshot })
    await info.attach("desktop", { path: screenshot, contentType: "image/png" })
    const trace = info.outputPath("desktop-trace.zip")
    await launched.app.context().tracing.stop({ path: trace })
    await info.attach("desktop-trace", { path: trace, contentType: "application/zip" })
  } finally {
    await launched.app.close()
  }
}
