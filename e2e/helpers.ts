import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test"

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
  const dataDir = join(userData, "data")
  await mkdir(dataDir, { recursive: true })

  const now = Date.now()
  const metas = sessions.map((s, i) => ({
    id: s.id,
    title: s.title,
    project: s.project ?? "e2e",
    provider: "mock",
    cwd: workDir,
    status: s.status ?? "idle",
    archived: s.archived === true,
    createdAt: now - (sessions.length - i) * 60_000,
    updatedAt: now - (sessions.length - i) * 30_000,
  }))
  await writeFile(
    join(dataDir, "index.json"),
    JSON.stringify(
      {
        version: 1,
        sessions: metas,
        usage: {},
        activeSessionId: metas[0]?.id ?? null,
      },
      null,
      2,
    ),
  )
  for (const meta of metas) {
    const dir = join(dataDir, "sessions", meta.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "hot.json"), "[]")
  }
  await writeFile(
    join(dataDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: "p1", name: "e2e", cwd: workDir, createdAt: now }],
    }),
  )

  const app = await electron.launch({
    args: [join(ROOT, "out", "main", "index.js")],
    cwd: ROOT,
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
