import { describe, expect, it } from "vitest"
import {
  beginAssistant,
  emitTurnItem,
  finishTurn,
} from "../src/main/adapters/stream-parse"
import type { AdapterCallbacks } from "../src/main/adapters/types"
import type { AgentTurnItem, ChatMessage } from "../src/shared/types"

/**
 * Grok's stream carries no timestamps and Claude times only its subagents, so
 * every tool card was either blank or showing how long it had been on screen.
 * The Hub measures from the first sighting of a call to the event that settles
 * it, and flags the result as its own rather than the CLI's.
 */
function recorder() {
  const emitted: AgentTurnItem[] = []
  const cb = {
    onMessage: (_m: ChatMessage) => {},
    onDelta: () => {},
    onStreamDone: () => {},
    onSessionEvent: () => {},
    onTurnItem: (_s: string, _m: string, item: AgentTurnItem) => {
      emitted.push(item)
    },
  } as unknown as AdapterCallbacks
  return { cb, emitted }
}

function clockFrom(times: number[]): () => number {
  let at = 0
  return () => times[Math.min(at++, times.length - 1)]!
}

const RUNNING: AgentTurnItem = {
  id: "t1",
  kind: "tool",
  status: "running",
  name: "Read",
}

describe("measured tool durations", () => {
  it("times a call from its first event to the one that settles it", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 1000, 3400]))
    emitTurnItem(turn, "s1", RUNNING, cb)
    emitTurnItem(turn, "s1", { ...RUNNING, status: "completed" }, cb)
    expect(emitted.at(-1)).toMatchObject({
      durationMs: 2400,
      durationMeasured: true,
    })
  })

  it("leaves a duration the CLI reported untouched", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 1000, 9000]))
    emitTurnItem(turn, "s1", RUNNING, cb)
    emitTurnItem(
      turn,
      "s1",
      { ...RUNNING, status: "completed", durationMs: 42 },
      cb,
    )
    expect(emitted.at(-1)).toMatchObject({ durationMs: 42 })
    expect(emitted.at(-1)).not.toHaveProperty("durationMeasured")
  })

  it("claims no duration for a call that arrived already finished", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 1000, 5000]))
    emitTurnItem(turn, "s1", { ...RUNNING, status: "completed" }, cb)
    expect(emitted.at(-1)).not.toHaveProperty("durationMs")
  })

  it("adds nothing while the call is still open", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 1000, 2000]))
    emitTurnItem(turn, "s1", RUNNING, cb)
    emitTurnItem(turn, "s1", { ...RUNNING, status: "running" }, cb)
    expect(emitted.at(-1)).not.toHaveProperty("durationMs")
  })

  it("times a call the turn had to settle on its behalf", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 1000, 7000]))
    emitTurnItem(turn, "s1", RUNNING, cb)
    finishTurn(turn, "s1", cb, "interrupted")
    expect(emitted.at(-1)).toMatchObject({
      status: "interrupted",
      durationMs: 6000,
      durationMeasured: true,
    })
  })

  it("times commands the same way", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 500, 1750]))
    const command: AgentTurnItem = {
      id: "c1",
      kind: "command",
      status: "running",
      command: "pnpm test",
    }
    emitTurnItem(turn, "s1", command, cb)
    emitTurnItem(turn, "s1", { ...command, status: "completed", exitCode: 0 }, cb)
    expect(emitted.at(-1)).toMatchObject({
      durationMs: 1250,
      durationMeasured: true,
    })
  })

  it("leaves kinds that carry no duration alone", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb, clockFrom([0, 100, 900]))
    const plan: AgentTurnItem = {
      id: "p1",
      kind: "plan",
      status: "running",
      text: "step one",
    }
    emitTurnItem(turn, "s1", plan, cb)
    emitTurnItem(turn, "s1", { ...plan, status: "completed" }, cb)
    expect(emitted.at(-1)).not.toHaveProperty("durationMs")
  })
})
