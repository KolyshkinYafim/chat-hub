export type SeedSessionInput = {
  id: string
  title: string
  project?: string
  status?: string
  archived?: boolean
}

export type SeedMeta = {
  id: string
  title: string
  project: string
  provider: string
  cwd: string
  status: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export function sessionMetas(
  sessions: readonly SeedSessionInput[],
  workDir: string,
  now: number,
): SeedMeta[]

export function writeSeedData(
  userData: string,
  metas: readonly SeedMeta[],
  workDir: string,
  now: number,
): Promise<void>
