import { afterAll, describe, expect, it } from "vitest"

import { CodexAppServerClient } from "../src/main/codex-protocol/client"
import type { ModelListResponse } from "../src/main/codex-protocol/generated/v2/ModelListResponse"
import type { ThreadStartResponse } from "../src/main/codex-protocol/generated/v2/ThreadStartResponse"
import type { TurnStartResponse } from "../src/main/codex-protocol/generated/v2/TurnStartResponse"

const live = process.env.CHAT_HUB_LIVE_CODEX === "1"
let client: CodexAppServerClient | undefined

describe.runIf(live)("installed Codex app-server", () => {
  afterAll(async () => client?.close())

  it("initializes and returns the account's available models", async () => {
    client = await CodexAppServerClient.connect({ binary: "codex" })
    const response = await client.request<ModelListResponse>("model/list", {
      limit: 50,
      includeHidden: false,
    })
    expect(response.data.length).toBeGreaterThan(0)
    expect(response.data.every((model) => Boolean(model.id))).toBe(true)
    const byId = new Map(response.data.map((model) => [model.id, model]))
    expect(byId.get("gpt-5.6-sol")?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"])
    expect(byId.get("gpt-5.6-terra")?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"])
    expect(byId.get("gpt-5.6-luna")?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["low", "medium", "high", "xhigh", "max"])
  }, 30_000)

  it("streams and completes a real ephemeral turn", async () => {
    client ??= await CodexAppServerClient.connect({ binary: "codex" })
    const started = await client.request<ThreadStartResponse>("thread/start", {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    })
    let text = ""
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const unsubscribe = client.onNotification((event) => {
      if (event.method === "item/agentMessage/delta") text += event.params.delta
      if (event.method === "turn/completed") resolveDone()
    })
    const turn = await client.request<TurnStartResponse>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Reply with exactly: OK", text_elements: [] }],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    })
    expect(turn.turn.id).toBeTruthy()
    await Promise.race([
      done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 30_000)),
    ])
    unsubscribe()
    expect(text.trim()).toContain("OK")
  }, 40_000)
})
