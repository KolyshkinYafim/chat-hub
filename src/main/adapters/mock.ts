import { randomUUID } from "node:crypto"
import type { TurnPlanStep } from "@shared/types"
import type {
  AgentAdapter,
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
} from "./types"

const REPLIES = [
  `## Plan

Разобрал запрос. Делаю минимальный diff, без косметики.

### Steps
1. Найти hot path в адаптере
2. Прокинуть \`SessionEvent\` только из main
3. Не трогать renderer, кроме отображения статуса

\`\`\`ts
cb.onSessionEvent({ type: "session.status", id, status: "running" })
\`\`\`

### Outcome
- ✅ Stream deltas в transcript
- ✅ Status never stuck without process
- ⏳ Waiting on your OK to open PR

Скажи **ship** или **iterate**.`,

  `## Findings

Прошёлся по session manager и bridge path.

| Check | Result |
|-------|--------|
| Event bus ownership | main only |
| Renderer invents status | no |
| JSONL bridge | append-only |

\`cwd\` пока берётся из process; для real CLI нужен folder picker + allowlist.

**Next:** wire one real adapter (Grok Build or OpenCode) behind the same \`AgentAdapter\` surface.`,

  `## Patch summary

Изменения локальные, mock-only:

- Dense workbench transcript (markdown-ish)
- Project-grouped sidebar
- Live Working / Waiting pills

\`\`\`diff
+ project: normalizeProject(input.project, cwd)
+ status label map running → Working
\`\`\`

Нужен input: продолжать UI polish или переключаться на real provider spawn?`,

  `## Done for this turn

Mock agent закончил turn. Status flips to **done** or **waiting_input** via the event bus only.

- Transcript streaming exercised
- OS notif path exercised on waiting/done
- Bridge line written for Session Monitor

Ready for follow-up.`,
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickReply(turn: number): string {
  return REPLIES[turn % REPLIES.length]
}

export class MockAdapter implements AgentAdapter {
  readonly id = "mock" as const
  readonly available = true

  private turns = new Map<string, number>()
  private aborts = new Map<string, AbortController>()

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    this.turns.set(opts.sessionId, 0)
    cb.onSessionEvent({
      type: "session.status",
      id: opts.sessionId,
      status: "idle",
    })
  }

  private async showcase(
    sessionId: string,
    cb: AdapterCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    const messageId = randomUUID()
    cb.onMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      streaming: true,
    })
    const stream = async (text: string) => {
      for (const token of text.match(/\S+\s*|\n+/g) ?? [text]) {
        if (signal.aborted) return
        cb.onDelta(sessionId, messageId, token)
        await sleep(24)
      }
    }
    const steps: TurnPlanStep[] = [
      { text: "Scan webhook retry paths", status: "pending" },
      { text: "Patch the backoff curve", status: "pending" },
      { text: "Run the test suite", status: "pending" },
      { text: "Summarize the change", status: "pending" },
    ]
    const plan = (
      status: "running" | "completed",
      patch: Record<number, "pending" | "running" | "completed">,
    ) => {
      for (const [index, next] of Object.entries(patch)) {
        steps[Number(index)] = { ...steps[Number(index)], status: next }
      }
      cb.onTurnItem(sessionId, messageId, {
        id: "plan-1",
        kind: "plan",
        status,
        text: "Fix webhook retries",
        steps: [...steps],
      })
    }

    await stream("## Working the task\n\nLaying out a plan first.\n\n")
    plan("running", { 0: "running" })
    await sleep(1600)

    cb.onTurnItem(sessionId, messageId, {
      id: "cmd-1",
      kind: "command",
      status: "running",
      command: 'rg "retry" src/webhooks -n',
    })
    await sleep(1900)
    cb.onTurnItem(sessionId, messageId, {
      id: "cmd-1",
      kind: "command",
      status: "completed",
      command: 'rg "retry" src/webhooks -n',
      output: "src/webhooks/backoff.ts:12: retries: attempt * 2\nsrc/webhooks/deliver.ts:44: if (retries > MAX_RETRIES) drop(event)",
      exitCode: 0,
      durationMs: 1840,
    })
    plan("running", { 0: "completed", 1: "running" })
    await stream("Retry math lives in `backoff.ts`. Switching it to exponential with jitter.\n\n")
    await sleep(1200)

    cb.onTurnItem(sessionId, messageId, {
      id: "edit-1",
      kind: "file_change",
      status: "completed",
      changes: [
        {
          path: "src/webhooks/backoff.ts",
          diff: "@@ -10,7 +10,8 @@\n-  return attempt * 2\n+  const base = 2 ** attempt\n+  return base + Math.random() * base",
        },
      ],
    })
    plan("running", { 1: "completed", 2: "running" })
    await sleep(1400)

    let allowed = true
    if (cb.onPermissionRequest) {
      const decision = await cb.onPermissionRequest({
        requestId: randomUUID(),
        sessionId,
        agentSessionId: sessionId,
        source: "mock",
        summary: "Run `pnpm test` to verify the backoff change",
        toolName: "Bash",
      })
      allowed = decision === "allow"
    }
    if (signal.aborted) {
      cb.onStreamDone(sessionId, messageId)
      return
    }
    if (allowed) {
      cb.onTurnItem(sessionId, messageId, {
        id: "cmd-2",
        kind: "command",
        status: "running",
        command: "pnpm test",
      })
      await sleep(2600)
      cb.onTurnItem(sessionId, messageId, {
        id: "cmd-2",
        kind: "command",
        status: "completed",
        command: "pnpm test",
        output: "Tests  42 passed (42)",
        exitCode: 0,
        durationMs: 2540,
      })
      await stream("Suite is green: **42 passed**.\n\n")
    } else {
      await stream("Skipping the test run — you denied it. The patch stays staged for review.\n\n")
    }
    plan("running", { 2: "completed", 3: "running" })
    await sleep(900)
    await stream("### Summary\n\n- Exponential backoff with jitter in `backoff.ts`\n- Delivery drop threshold untouched\n- Ready to commit\n")
    plan("completed", { 3: "completed" })

    cb.onUsage?.(
      sessionId,
      {
        inputTokens: 5124,
        outputTokens: 892,
        costUsd: 0.06,
        durationMs: 14200,
        contextWindow: 200_000,
      },
      messageId,
    )
    cb.onStreamDone(sessionId, messageId)
    cb.onSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "assistant",
      preview: "Fixed webhook retries: exponential backoff with jitter, 42 tests green.",
    })
    cb.onSessionEvent({ type: "session.status", id: sessionId, status: "done" })
    cb.onSessionEvent({ type: "session.ended", id: sessionId, reason: "done" })
  }

  async send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
    _opts?: AdapterSendOpts,
  ): Promise<void> {
    this.aborts.get(sessionId)?.abort()
    const controller = new AbortController()
    this.aborts.set(sessionId, controller)

    if (/showcase/i.test(message)) {
      cb.onSessionEvent({
        type: "session.status",
        id: sessionId,
        status: "running",
      })
      try {
        await this.showcase(sessionId, cb, controller.signal)
      } catch (err) {
        if (!controller.signal.aborted) {
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "error",
          })
          console.error("[mock-adapter]", err)
        }
      } finally {
        if (this.aborts.get(sessionId) === controller) {
          this.aborts.delete(sessionId)
        }
      }
      return
    }

    const turn = this.turns.get(sessionId) ?? 0
    this.turns.set(sessionId, turn + 1)

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    const messageId = randomUUID()
    const createdAt = Date.now()
    cb.onMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      content: "",
      createdAt,
      streaming: true,
    })

    const body = pickReply(turn)
    // Stream in small chunks so markdown structure appears progressively.
    const chunks = body.match(/\S+\s*|\n+/g) ?? [body]

    try {
      for (const token of chunks) {
        if (controller.signal.aborted) {
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "idle",
          })
          cb.onStreamDone(sessionId, messageId)
          return
        }
        cb.onDelta(sessionId, messageId, token)
        await sleep(12 + Math.floor(Math.random() * 28))
      }

      if (controller.signal.aborted) {
        cb.onStreamDone(sessionId, messageId)
        return
      }

      cb.onStreamDone(sessionId, messageId)
      cb.onSessionEvent({
        type: "session.message",
        id: sessionId,
        role: "assistant",
        preview: body.replace(/\s+/g, " ").slice(0, 160),
      })

      const nextStatus = turn % 2 === 0 ? "done" : "waiting_input"
      cb.onSessionEvent({
        type: "session.status",
        id: sessionId,
        status: nextStatus,
      })

      if (nextStatus === "done") {
        cb.onSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "done",
        })
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        cb.onSessionEvent({
          type: "session.status",
          id: sessionId,
          status: "error",
        })
        cb.onSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "error",
        })
        console.error("[mock-adapter]", err)
      }
      cb.onStreamDone(sessionId, messageId)
    } finally {
      if (this.aborts.get(sessionId) === controller) {
        this.aborts.delete(sessionId)
      }
    }

    void message
  }

  async abort(sessionId: string): Promise<void> {
    this.aborts.get(sessionId)?.abort()
    this.aborts.delete(sessionId)
  }

  async dispose(sessionId: string): Promise<void> {
    await this.abort(sessionId)
    this.turns.delete(sessionId)
  }
}
