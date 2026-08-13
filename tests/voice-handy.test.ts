import { describe, expect, it } from "vitest"
import {
  cancelHandyTranscription,
  ensureHandyRunning,
  HANDY_BINARY,
  handyInstalled,
  toggleHandyTranscription,
  type HandyDeps,
} from "../src/main/voice-handy"
import {
  nextVoicePhase,
  VOICE_WAIT_TIMEOUT_MS,
  type VoiceEvent,
  type VoicePhase,
} from "@renderer/lib/voice-state"

/**
 * A machine in a chosen state: Handy installed or not, its process alive per
 * successive pgrep calls (the last answer repeats), every spawn recorded.
 */
function machine(over: {
  installed?: boolean
  alive?: boolean[]
  runOk?: boolean
  launchOk?: boolean
}) {
  const spawns: string[] = []
  const alive = [...(over.alive ?? [false])]
  const deps: HandyDeps = {
    exists: (path) => (over.installed ?? true) && path === HANDY_BINARY,
    run: (command, args) => {
      const line = [command, ...args].join(" ")
      spawns.push(line)
      if (command === "pgrep") {
        return Promise.resolve(
          alive.length > 1 ? (alive.shift() as boolean) : (alive[0] ?? false),
        )
      }
      if (command === "open") return Promise.resolve(over.launchOk ?? true)
      return Promise.resolve(over.runOk ?? true)
    },
    delay: () => Promise.resolve(),
  }
  return { deps, spawns }
}

describe("handyInstalled", () => {
  it("keys off the app bundle's binary", () => {
    expect(handyInstalled(machine({ installed: true }).deps)).toBe(true)
    expect(handyInstalled(machine({ installed: false }).deps)).toBe(false)
  })
})

describe("ensureHandyRunning", () => {
  it("does not launch when the process is already alive", async () => {
    const { deps, spawns } = machine({ alive: [true] })

    expect(await ensureHandyRunning(deps)).toBe(true)
    expect(spawns).toEqual(["pgrep -x handy"])
  })

  it("launches a dead-but-installed Handy and waits for it to appear", async () => {
    const { deps, spawns } = machine({ alive: [false, false, true] })

    expect(await ensureHandyRunning(deps)).toBe(true)
    expect(spawns).toEqual([
      "pgrep -x handy",
      "open -a Handy",
      "pgrep -x handy",
      "pgrep -x handy",
    ])
  })

  it("gives up when Handy never comes up", async () => {
    const { deps, spawns } = machine({ alive: [false] })

    expect(await ensureHandyRunning(deps)).toBe(false)
    expect(spawns.filter((line) => line.startsWith("open")).length).toBe(1)
    expect(spawns.some((line) => line.startsWith(HANDY_BINARY))).toBe(false)
  })

  it("reports a failed launch without polling for a ghost", async () => {
    const { deps, spawns } = machine({ alive: [false], launchOk: false })

    expect(await ensureHandyRunning(deps)).toBe(false)
    expect(spawns).toEqual(["pgrep -x handy", "open -a Handy"])
  })

  it("touches nothing when Handy is not installed", async () => {
    const { deps, spawns } = machine({ installed: false })

    expect(await ensureHandyRunning(deps)).toBe(false)
    expect(spawns).toEqual([])
  })
})

describe("toggleHandyTranscription", () => {
  it("forwards the toggle flag to the running instance", async () => {
    const { deps, spawns } = machine({ alive: [true] })

    expect(await toggleHandyTranscription(deps)).toBe(true)
    expect(spawns).toContain(`${HANDY_BINARY} --toggle-transcription`)
  })

  it("boots Handy first when installed but dead", async () => {
    const { deps, spawns } = machine({ alive: [false, true] })

    expect(await toggleHandyTranscription(deps)).toBe(true)
    expect(spawns.indexOf("open -a Handy")).toBeLessThan(
      spawns.indexOf(`${HANDY_BINARY} --toggle-transcription`),
    )
  })

  it("refuses when Handy is missing, spawning nothing", async () => {
    const { deps, spawns } = machine({ installed: false })

    expect(await toggleHandyTranscription(deps)).toBe(false)
    expect(spawns).toEqual([])
  })

  it("surfaces a failed spawn as false", async () => {
    const { deps } = machine({ alive: [true], runOk: false })

    expect(await toggleHandyTranscription(deps)).toBe(false)
  })
})

describe("cancelHandyTranscription", () => {
  it("forwards the cancel flag to the running instance", async () => {
    const { deps, spawns } = machine({ alive: [true] })

    expect(await cancelHandyTranscription(deps)).toBe(true)
    expect(spawns).toContain(`${HANDY_BINARY} --cancel`)
  })

  it("never spawns the binary when no instance is running — that would launch one", async () => {
    const { deps, spawns } = machine({ alive: [false] })

    expect(await cancelHandyTranscription(deps)).toBe(true)
    expect(spawns).toEqual(["pgrep -x handy"])
  })

  it("is a no-op when Handy is not installed", async () => {
    const { deps, spawns } = machine({ installed: false })

    expect(await cancelHandyTranscription(deps)).toBe(true)
    expect(spawns).toEqual([])
  })
})

describe("voice button phases", () => {
  function after(phase: VoicePhase, ...events: VoiceEvent[]): VoicePhase {
    return events.reduce(nextVoicePhase, phase)
  }

  it("walks the happy path: record, stop, text lands", () => {
    expect(after("idle", { type: "toggle-accepted" })).toBe("recording")
    expect(
      after("idle", { type: "toggle-accepted" }, { type: "stop-requested" }),
    ).toBe("waiting")
    expect(
      after(
        "idle",
        { type: "toggle-accepted" },
        { type: "stop-requested" },
        { type: "text-arrived" },
      ),
    ).toBe("idle")
  })

  it("resets to idle when the toggle is refused", () => {
    expect(after("idle", { type: "toggle-failed" })).toBe("idle")
    expect(after("recording", { type: "toggle-failed" })).toBe("idle")
  })

  it("Esc cancels a recording", () => {
    expect(after("recording", { type: "cancelled" })).toBe("idle")
  })

  it("the wait times out to idle so a lost transcription never wedges the button", () => {
    expect(after("waiting", { type: "timed-out" })).toBe("idle")
    expect(VOICE_WAIT_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it("keeps recording across a blur but drops the wait — the paste follows focus", () => {
    expect(after("recording", { type: "window-blurred" })).toBe("recording")
    expect(after("waiting", { type: "window-blurred" })).toBe("idle")
  })

  it("ignores events that do not belong to the current phase", () => {
    expect(after("idle", { type: "stop-requested" })).toBe("idle")
    expect(after("idle", { type: "text-arrived" })).toBe("idle")
    expect(after("recording", { type: "toggle-accepted" })).toBe("recording")
    expect(after("recording", { type: "timed-out" })).toBe("recording")
    expect(after("waiting", { type: "toggle-accepted" })).toBe("waiting")
  })

  it("stray typing while idle stays idle — text-arrived is only meaningful in waiting", () => {
    expect(after("idle", { type: "window-blurred" })).toBe("idle")
    expect(after("idle", { type: "timed-out" })).toBe("idle")
  })
})
