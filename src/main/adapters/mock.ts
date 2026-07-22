import { randomUUID } from "node:crypto"
import type { AgentAdapter, AdapterCallbacks, AdapterStartOpts } from "./types"

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

  async send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
  ): Promise<void> {
    this.aborts.get(sessionId)?.abort()
    const controller = new AbortController()
    this.aborts.set(sessionId, controller)

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
