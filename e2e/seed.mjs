import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export function sessionMetas(sessions, workDir, now) {
  return sessions.map((s, i) => ({
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
}

export async function writeSeedData(userData, metas, workDir, now) {
  const dataDir = join(userData, "data")
  await mkdir(dataDir, { recursive: true })
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
}
