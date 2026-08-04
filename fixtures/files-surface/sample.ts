/**
 * Fixture for the Files surface. The block comment above spans several lines
 * on purpose: a per-line tokeniser colours only the first one, so this is the
 * cheapest way to see whether the editor carries comment state across lines.
 */
import { readFile } from "node:fs/promises"

export type RetryPolicy = {
  attempts: number
  baseDelayMs: number
  jitter: boolean
}

const DEFAULT_POLICY: RetryPolicy = {
  attempts: 5,
  baseDelayMs: 250,
  jitter: true,
}

// A single-line comment, for contrast.
export async function loadPolicy(path: string): Promise<RetryPolicy> {
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as Partial<RetryPolicy>
  return {
    attempts: parsed.attempts ?? DEFAULT_POLICY.attempts,
    baseDelayMs: parsed.baseDelayMs ?? DEFAULT_POLICY.baseDelayMs,
    jitter: parsed.jitter ?? DEFAULT_POLICY.jitter,
  }
}

export function backoffFor(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** attempt
  const spread = policy.jitter ? Math.random() * 0.3 : 0
  return Math.round(exponential * (1 + spread))
}
