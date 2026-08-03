import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Project } from "@shared/types"
import { projectFromCwd } from "@shared/project"
import { writeFileAtomic } from "./atomic-write"

type PersistedProjects = {
  version: 1
  projects: Project[]
}

/**
 * First-class project list, persisted independently of sessions so a folder
 * stays pinned in the sidebar even with zero sessions.
 */
export class ProjectStore {
  private projects: Project[] = []

  constructor(private readonly filePath: string) {}

  async load(): Promise<Project[]> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      const data = JSON.parse(raw) as PersistedProjects
      if (data?.version === 1 && Array.isArray(data.projects)) {
        // Drop entries whose folder no longer exists.
        this.projects = data.projects.filter((p) => dirExists(p.cwd))
      }
    } catch {
      this.projects = []
    }
    return this.list()
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Register a project by folder. Idempotent on cwd (returns existing). */
  async add(cwd: string, name?: string): Promise<Project> {
    const real = resolveDir(cwd)
    const existing = this.projects.find((p) => p.cwd === real)
    if (existing) return existing
    const project: Project = {
      id: randomUUID(),
      name: name?.trim() || projectFromCwd(real),
      cwd: real,
      createdAt: Date.now(),
    }
    this.projects.push(project)
    await this.save()
    return project
  }

  /** Register a folder if it exists, swallowing errors (used on session create). */
  async ensure(cwd: string, name?: string): Promise<void> {
    try {
      await this.add(cwd, name)
    } catch {
      /* non-existent / racing folder — ignore */
    }
  }

  async remove(id: string): Promise<Project[]> {
    this.projects = this.projects.filter((p) => p.id !== id)
    await this.save()
    return this.list()
  }

  async renameProject(id: string, name: string): Promise<Project[]> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error("Project name required")
    this.projects = this.projects.map((p) =>
      p.id === id ? { ...p, name: trimmed } : p,
    )
    await this.save()
    return this.list()
  }

  private async save(): Promise<void> {
    const data: PersistedProjects = { version: 1, projects: this.projects }
    await writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "projects.json")
  }
}

function dirExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function resolveDir(cwd: string): string {
  const raw = cwd?.trim()
  if (!raw) throw new Error("Folder required")
  const real = realpathSync(raw)
  if (!statSync(real).isDirectory()) {
    throw new Error(`Not a directory: ${raw}`)
  }
  return real
}
