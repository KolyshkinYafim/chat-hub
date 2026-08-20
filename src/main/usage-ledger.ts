import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  SessionMeta,
  SessionUsage,
  TurnUsage,
  UsageLedgerEntry,
  UsageSummary,
  UsageWindowTotals,
} from "@shared/types"
import { DAY_MS, dayKey } from "@shared/day"
import { writeFileAtomic } from "./atomic-write"

type LedgerFile = { version: 1; entries: UsageLedgerEntry[] }

/** Accumulates into the row matching day+provider+model, or appends a new one. */
export function mergeLedgerEntry(
  entries: UsageLedgerEntry[],
  add: UsageLedgerEntry,
): UsageLedgerEntry[] {
  const idx = entries.findIndex(
    (e) => e.day === add.day && e.provider === add.provider && e.model === add.model,
  )
  if (idx === -1) return [...entries, add]
  const cur = entries[idx]
  const next = [...entries]
  next[idx] = {
    ...cur,
    inputTokens: cur.inputTokens + add.inputTokens,
    outputTokens: cur.outputTokens + add.outputTokens,
    cacheReadTokens: cur.cacheReadTokens + add.cacheReadTokens,
    cacheCreateTokens: cur.cacheCreateTokens + add.cacheCreateTokens,
    costUsd: cur.costUsd + add.costUsd,
    turns: cur.turns + add.turns,
  }
  return next
}

/** Today / last-7-days / last-30-days totals, windows inclusive of `now`'s day. */
export function rollupWindows(
  entries: UsageLedgerEntry[],
  now: number,
): Pick<UsageSummary, "today" | "last7d" | "last30d"> {
  const today = dayKey(now)
  return {
    today: windowTotals(entries, today, today),
    last7d: windowTotals(entries, dayKey(now - 6 * DAY_MS), today),
    last30d: windowTotals(entries, dayKey(now - 29 * DAY_MS), today),
  }
}

function windowTotals(
  entries: UsageLedgerEntry[],
  from: string,
  to: string,
): UsageWindowTotals {
  const out: UsageWindowTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    turns: 0,
  }
  for (const e of entries) {
    if (e.day < from || e.day > to) continue
    out.inputTokens += e.inputTokens
    out.outputTokens += e.outputTokens
    out.cacheReadTokens += e.cacheReadTokens
    out.cacheCreateTokens += e.cacheCreateTokens
    out.costUsd += e.costUsd
    out.turns += e.turns
  }
  return out
}

/**
 * One-time backfill for installs that predate the ledger: per-turn history was
 * never persisted, so each session's lifetime total lands on its updatedAt day —
 * honest about magnitude, approximate about date.
 */
export function seedFromSessions(
  sessions: SessionMeta[],
  usage: Record<string, SessionUsage>,
): UsageLedgerEntry[] {
  let entries: UsageLedgerEntry[] = []
  for (const session of sessions) {
    const total = usage[session.id]
    if (!total) continue
    entries = mergeLedgerEntry(entries, {
      day: dayKey(session.updatedAt),
      provider: session.provider,
      model: session.model ?? "unknown",
      inputTokens: total.inputTokens ?? 0,
      outputTokens: total.outputTokens ?? 0,
      cacheReadTokens: total.cacheReadTokens ?? 0,
      cacheCreateTokens: total.cacheCreateTokens ?? 0,
      costUsd: total.costUsd ?? 0,
      turns: total.turns,
    })
  }
  return entries
}

/**
 * Compact daily usage rollup persisted across restarts. Writes are serialized
 * and failures only warn — recording usage must never block or kill a turn.
 */
export class UsageLedger {
  private entries: UsageLedgerEntry[] = []
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  static defaultPath(userData: string): string {
    return join(userData, "data", "usage-ledger.json")
  }

  /** Loads the file; garbage parses as empty, a missing file starts from `seed`. */
  async init(seed: UsageLedgerEntry[] = []): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      this.entries = seed
      if (seed.length > 0) {
        await this.write().catch((err) => {
          console.warn("[usage-ledger] seed write failed", err)
        })
      }
      return
    }
    try {
      const data = JSON.parse(raw) as LedgerFile
      this.entries = sanitizeEntries(data?.entries)
    } catch (err) {
      console.warn("[usage-ledger] unreadable ledger, starting empty", err)
      this.entries = []
    }
  }

  record(provider: string, model: string | undefined, turn: TurnUsage): Promise<void> {
    const run = this.queue.then(async () => {
      this.entries = mergeLedgerEntry(this.entries, {
        day: dayKey(this.now()),
        provider,
        model: model ?? "unknown",
        inputTokens: turn.inputTokens ?? 0,
        outputTokens: turn.outputTokens ?? 0,
        cacheReadTokens: turn.cacheReadTokens ?? 0,
        cacheCreateTokens: turn.cacheCreateTokens ?? 0,
        costUsd: turn.costUsd ?? 0,
        turns: 1,
      })
      await this.write()
    })
    this.queue = run.catch((err) => {
      console.warn("[usage-ledger] write failed", err)
    })
    return this.queue
  }

  summary(): UsageSummary {
    const entries = [...this.entries].sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
    )
    return { entries, ...rollupWindows(entries, this.now()) }
  }

  private write(): Promise<void> {
    const payload: LedgerFile = { version: 1, entries: this.entries }
    return writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2))
  }
}

function sanitizeEntries(entries: unknown): UsageLedgerEntry[] {
  if (!Array.isArray(entries)) return []
  const out: UsageLedgerEntry[] = []
  for (const item of entries) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (
      typeof r.day !== "string" ||
      typeof r.provider !== "string" ||
      typeof r.model !== "string"
    ) {
      continue
    }
    out.push({
      day: r.day,
      provider: r.provider,
      model: r.model,
      inputTokens: finite(r.inputTokens),
      outputTokens: finite(r.outputTokens),
      cacheReadTokens: finite(r.cacheReadTokens),
      cacheCreateTokens: finite(r.cacheCreateTokens),
      costUsd: finite(r.costUsd),
      turns: finite(r.turns),
    })
  }
  return out
}

function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
