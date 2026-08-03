import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { HubEvent } from "@shared/types"
import {
  hookMatches,
  HookRunner,
  loadHooksFromCwd,
  parseHookDefinition,
} from "../src/main/hooks"
import type { EventBus } from "../src/main/event-bus"
import type { HookDefinition } from "@shared/hooks"

function busStub(sink: HubEvent[] = []): EventBus {
  return {
    on: () => () => {},
    emit: (e: HubEvent) => {
      sink.push(e)
    },
    emitSession: () => {},
  } as unknown as EventBus
}

function baseHook(over: Partial<HookDefinition> = {}): HookDefinition {
  return {
    name: "demo",
    trigger: "session_start",
    action: { kind: "shell", value: "echo ok" },
    timeout: 5_000,
    enabled: true,
    ...over,
  }
}

describe("parseHookDefinition", () => {
  it("accepts a valid hook json", () => {
    const def = parseHookDefinition(
      "lint",
      JSON.stringify({
        trigger: "turn_done",
        action: { kind: "shell", value: "pnpm lint" },
        timeout: 12_000,
        enabled: true,
      }),
    )
    expect(def).toEqual({
      name: "lint",
      trigger: "turn_done",
      action: { kind: "shell", value: "pnpm lint" },
      timeout: 12_000,
      enabled: true,
    })
  })

  it("defaults timeout and enabled", () => {
    const def = parseHookDefinition(
      "greet",
      JSON.stringify({
        trigger: "session_start",
        action: { kind: "prompt", value: "hi" },
      }),
    )
    expect(def?.timeout).toBe(30_000)
    expect(def?.enabled).toBe(true)
  })

  it("rejects invalid json and unknown triggers", () => {
    expect(parseHookDefinition("x", "{not json")).toBeNull()
    expect(
      parseHookDefinition(
        "x",
        JSON.stringify({
          trigger: "nope",
          action: { kind: "shell", value: "true" },
        }),
      ),
    ).toBeNull()
    expect(
      parseHookDefinition(
        "x",
        JSON.stringify({
          trigger: "session_start",
          action: { kind: "fly", value: "x" },
        }),
      ),
    ).toBeNull()
    expect(
      parseHookDefinition(
        "x",
        JSON.stringify({
          trigger: "file_save",
          match: "(",
          action: { kind: "shell", value: "true" },
        }),
      ),
    ).toBeNull()
  })
})

describe("hookMatches", () => {
  it("matches trigger without match always", () => {
    const h = baseHook({ trigger: "turn_done" })
    expect(hookMatches(h, "turn_done")).toBe(true)
    expect(hookMatches(h, "session_start")).toBe(false)
  })

  it("filters by match regex when present", () => {
    const h = baseHook({
      trigger: "file_save",
      match: ".*\\.ts$",
    })
    expect(hookMatches(h, "file_save", "src/a.ts")).toBe(true)
    expect(hookMatches(h, "file_save", "src/a.js")).toBe(false)
    expect(hookMatches(h, "file_save")).toBe(false)
  })

  it("skips disabled hooks", () => {
    const h = baseHook({ enabled: false })
    expect(hookMatches(h, "session_start")).toBe(false)
  })
})

describe("loadHooksFromCwd", () => {
  it("loads valid files and skips invalid ones", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "ok.json"),
      JSON.stringify({
        trigger: "session_start",
        action: { kind: "shell", value: "echo hi" },
      }),
    )
    await writeFile(join(dir, "bad.json"), "{nope")
    await writeFile(join(dir, "readme.txt"), "ignore me")

    const hooks = await loadHooksFromCwd(cwd)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.name).toBe("ok")
  })

  it("returns empty when the hooks dir is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-empty-"))
    expect(await loadHooksFromCwd(cwd)).toEqual([])
  })
})

describe("HookRunner", () => {
  it("runs a shell hook and records exit code/output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-run-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "echo.json"),
      JSON.stringify({
        trigger: "session_start",
        action: { kind: "shell", value: "printf 'hello-hooks'" },
      }),
    )

    const events: HubEvent[] = []
    const runner = new HookRunner(busStub(events), () => {})
    await runner.loadForSession("s1", cwd)
    const runs = await runner.run("s1", "session_start")

    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("ok")
    expect(runs[0]!.output).toContain("hello-hooks")
    expect(runs[0]!.exitCode).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "hook.ran",
      run: { hookName: "echo", status: "ok" },
    })
  })

  it("marks a hanging shell as timeout without throwing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-to-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "slow.json"),
      JSON.stringify({
        trigger: "turn_done",
        action: { kind: "shell", value: "sleep 5" },
        timeout: 80,
      }),
    )

    const runner = new HookRunner(busStub(), () => {})
    await runner.loadForSession("s1", cwd)
    const t0 = Date.now()
    const runs = await runner.run("s1", "turn_done")
    const elapsed = Date.now() - t0

    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("timeout")
    // Must not wait out the full sleep — timeout is the contract.
    expect(elapsed).toBeLessThan(3_000)
  }, 10_000)

  it("queues prompt hooks via the handler", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-prompt-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "ask.json"),
      JSON.stringify({
        trigger: "session_start",
        action: { kind: "prompt", value: "summarize the repo" },
      }),
    )

    const prompts: Array<{ id: string; text: string }> = []
    const runner = new HookRunner(busStub(), (id, text) => {
      prompts.push({ id, text })
    })
    await runner.loadForSession("s9", cwd)
    const runs = await runner.run("s9", "session_start")

    expect(prompts).toEqual([{ id: "s9", text: "summarize the repo" }])
    expect(runs[0]!.status).toBe("ok")
    expect(runs[0]!.output).toBe("queued prompt")
  })

  it("does not run enabled:false hooks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-off-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "off.json"),
      JSON.stringify({
        trigger: "session_start",
        action: { kind: "shell", value: "echo should-not-run" },
        enabled: false,
      }),
    )

    const runner = new HookRunner(busStub(), () => {})
    await runner.loadForSession("s1", cwd)
    expect(await runner.run("s1", "session_start")).toEqual([])
  })

  it("records a non-zero shell exit as error with exitCode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-hooks-fail-"))
    const dir = join(cwd, ".chathub", "hooks")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "fail.json"),
      JSON.stringify({
        trigger: "turn_done",
        action: { kind: "shell", value: "printf 'boom'; exit 7" },
      }),
    )

    const runner = new HookRunner(busStub(), () => {})
    await runner.loadForSession("s1", cwd)
    const runs = await runner.run("s1", "turn_done")
    expect(runs[0]!.status).toBe("error")
    expect(runs[0]!.exitCode).toBe(7)
    expect(runs[0]!.output).toContain("boom")
  })
})

describe("hookMatches file_save / tool triggers", () => {
  it("keeps the five trigger values available for later wiring", () => {
    for (const trigger of [
      "session_start",
      "turn_done",
      "file_save",
      "pre_tool_use",
      "post_tool_use",
    ] as const) {
      expect(hookMatches(baseHook({ trigger }), trigger)).toBe(true)
    }
  })
})

// Silence unused import if vitest tree-shakes vi in some configs.
void vi
