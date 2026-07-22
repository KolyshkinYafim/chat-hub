import { randomUUID } from "node:crypto"
import type { AgentAdapter, AdapterCallbacks, AdapterStartOpts } from "./types"

const REPLIES = [
  "I looked through the request and sketched a plan. Next I'll stub the adapter surface and stream a short reply so the UI can show honest status transitions.",
  "Mock agent here. Status comes only from the event bus — when this stream ends, the session flips to done (or waiting_input on alternate turns).",
  "Acknowledged. In a real provider this would be token deltas from the CLI. For now I'm faking a multi-sentence answer so transcript rendering stays exercised.",
  "Done with the mock work. If you send another message I'll stream again and occasionally pause for input.",
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
    const tokens = body.split(/(\s+)/).filter(Boolean)

    try {
      for (const token of tokens) {
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
        await sleep(28 + Math.floor(Math.random() * 40))
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
        preview: body.slice(0, 160),
      })

      // Alternate done vs waiting_input so notifications and status UI get exercise.
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
