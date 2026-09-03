import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  _electron as electron,
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
}

const ROOT = resolve(__dirname, "..")

export async function launchApp(
  sessions: readonly SeedSession[] = [],
): Promise<LaunchedApp> {
  const userData = await mkdtemp(join(tmpdir(), "chat-hub-e2e-"))
  const workDir = await mkdtemp(join(tmpdir(), "chat-hub-work-"))
  const now = Date.now()
  const metas = sessionMetas(sessions, workDir, now)
  await writeSeedData(userData, metas, workDir, now)

  const slowMo = Number(process.env.E2E_SLOWMO ?? "0")
  const app = await electron.launch({
    args: [join(ROOT, "out", "main", "index.js")],
    cwd: ROOT,
    slowMo: Number.isFinite(slowMo) && slowMo > 0 ? slowMo : undefined,
    env: {
      ...process.env,
      CHAT_HUB_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { app, page, userData, workDir }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close()
}
