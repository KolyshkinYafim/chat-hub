import { describe, expect, it, vi } from "vitest"

const spawned: string[][] = []

vi.mock("../src/main/adapters/process-runner", () => ({
  runProcess: (spec: { args: string[] }) => {
    spawned.push(spec.args)
    return {
      pid: 1,
      abort: () => {},
      done: Promise.resolve({ code: 0, signal: null }),
    }
  },
}))

vi.mock("../src/main/adapters/binary", () => ({
  findBinary: () => "/usr/bin/grok",
  isExecutable: () => true,
}))

const { GrokAdapter } = await import("../src/main/adapters/grok")

const callbacks = {
  onSessionEvent: () => {},
  onMessage: () => {},
  onDelta: () => {},
  onStreamDone: () => {},
  onTurnItem: () => {},
}

describe("GrokAdapter effort", () => {
  it("hands the composer's effort to the CLI", async () => {
    const adapter = new GrokAdapter()
    await adapter.start({ sessionId: "s1", cwd: "/tmp", provider: "grok" }, callbacks)
    await adapter.send("s1", "hi", callbacks, { effort: "xhigh" })
    const args = spawned.at(-1) ?? []
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("xhigh")
  })

  it("sends no effort flag when none was chosen", async () => {
    const adapter = new GrokAdapter()
    await adapter.start({ sessionId: "s2", cwd: "/tmp", provider: "grok" }, callbacks)
    await adapter.send("s2", "hi", callbacks)
    expect(spawned.at(-1)).not.toContain("--reasoning-effort")
  })
})
