import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_OLLAMA_BASE_URL,
  OllamaAdapter,
  buildOllamaChatPayload,
  ndjsonLines,
  normalizeOllamaBaseUrl,
  parseOllamaChatLine,
  renderOllamaFailure,
} from "../src/main/adapters/ollama"
import {
  parseOllamaTags,
  probeOllama,
  type OllamaFetch,
} from "../src/main/provider-probe"
import type { AdapterCallbacks } from "../src/main/adapters/types"

function callbacks() {
  return {
    onSessionEvent: vi.fn(),
    onMessage: vi.fn(),
    onDelta: vi.fn(),
    onStreamDone: vi.fn(),
    onTurnItem: vi.fn(),
    onUsage: vi.fn(),
  } satisfies AdapterCallbacks
}

function statusesOf(cb: ReturnType<typeof callbacks>): string[] {
  return cb.onSessionEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === "session.status")
    .map((event) => (event as { status: string }).status)
}

function endedReasonsOf(cb: ReturnType<typeof callbacks>): string[] {
  return cb.onSessionEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === "session.ended")
    .map((event) => (event as { reason: string }).reason)
}

function textOf(cb: ReturnType<typeof callbacks>): string {
  return cb.onDelta.mock.calls.map(([, , delta]) => delta).join("")
}

function streamingResponse(lines: string[]): unknown {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const line of lines) yield line
    })(),
    text: async () => "",
  }
}

describe("normalizeOllamaBaseUrl", () => {
  it("falls back to the local default", () => {
    expect(normalizeOllamaBaseUrl(undefined)).toBe(DEFAULT_OLLAMA_BASE_URL)
    expect(normalizeOllamaBaseUrl("   ")).toBe(DEFAULT_OLLAMA_BASE_URL)
  })

  it("strips trailing slashes", () => {
    expect(normalizeOllamaBaseUrl("http://box:11434/")).toBe("http://box:11434")
    expect(normalizeOllamaBaseUrl(" http://box:11434// ")).toBe("http://box:11434")
  })
})

describe("buildOllamaChatPayload", () => {
  it("maps the system prompt, history, and current message in order", () => {
    const payload = buildOllamaChatPayload({
      model: "llama3.2",
      message: "and now?",
      systemPrompt: "be terse",
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    })
    expect(payload).toEqual({
      model: "llama3.2",
      stream: true,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "and now?" },
      ],
    })
  })

  it("drops blank history entries and skips an absent system prompt", () => {
    const payload = buildOllamaChatPayload({
      model: "qwen2.5",
      message: "go",
      history: [
        { role: "assistant", content: "   " },
        { role: "user", content: "kept" },
      ],
    })
    expect(payload.messages).toEqual([
      { role: "user", content: "kept" },
      { role: "user", content: "go" },
    ])
  })
})

describe("parseOllamaChatLine", () => {
  it("reads a content delta", () => {
    const event = parseOllamaChatLine(
      '{"model":"llama3.2","message":{"role":"assistant","content":"Hel"},"done":false}',
    )
    expect(event).toEqual({ delta: "Hel", done: false, usage: undefined })
  })

  it("reads the done line with eval stats mapped to usage", () => {
    const event = parseOllamaChatLine(
      '{"model":"llama3.2","message":{"role":"assistant","content":""},"done":true,"total_duration":1500000000,"prompt_eval_count":12,"eval_count":34}',
    )
    expect(event?.done).toBe(true)
    expect(event?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      durationMs: 1500,
    })
  })

  it("reports a done line without stats as having no usage", () => {
    const event = parseOllamaChatLine('{"done":true}')
    expect(event).toEqual({ delta: "", done: true, usage: undefined })
  })

  it("surfaces server error lines", () => {
    const event = parseOllamaChatLine('{"error":"model \'nope\' not found"}')
    expect(event?.error).toBe("model 'nope' not found")
    expect(event?.done).toBe(true)
  })

  it("returns null for malformed and empty lines", () => {
    expect(parseOllamaChatLine("")).toBeNull()
    expect(parseOllamaChatLine("   ")).toBeNull()
    expect(parseOllamaChatLine("{truncated")).toBeNull()
    expect(parseOllamaChatLine("plain text noise")).toBeNull()
    expect(parseOllamaChatLine("[1,2]")).toBeNull()
  })
})

describe("ndjsonLines", () => {
  it("reassembles lines split across chunks and flushes the tail", async () => {
    const chunks = (async function* () {
      yield '{"a":1}\n{"b"'
      yield ':2}\n'
      yield '{"c":3}'
    })()
    const lines: string[] = []
    for await (const line of ndjsonLines(chunks)) lines.push(line)
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it("decodes byte chunks that split multibyte characters", async () => {
    const bytes = new TextEncoder().encode('{"text":"héllo"}\n')
    const chunks = (async function* () {
      yield bytes.slice(0, 10)
      yield bytes.slice(10)
    })()
    const lines: string[] = []
    for await (const line of ndjsonLines(chunks)) lines.push(line)
    expect(lines).toEqual(['{"text":"héllo"}'])
  })
})

describe("parseOllamaTags", () => {
  it("lists installed model names", () => {
    expect(
      parseOllamaTags({
        models: [{ name: "llama3.2:latest" }, { name: "qwen2.5-coder:7b" }],
      }),
    ).toEqual([
      { id: "llama3.2:latest", label: "llama3.2:latest" },
      { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b" },
    ])
  })

  it("tolerates junk shapes", () => {
    expect(parseOllamaTags(null)).toEqual([])
    expect(parseOllamaTags({})).toEqual([])
    expect(parseOllamaTags({ models: "nope" })).toEqual([])
    expect(parseOllamaTags({ models: [{ name: 5 }, null, { name: "ok" }] })).toEqual([
      { id: "ok", label: "ok" },
    ])
  })
})

describe("probeOllama", () => {
  it("reports not running when the connection is refused", async () => {
    const refused: OllamaFetch = async () => {
      throw new Error("fetch failed")
    }
    const result = await probeOllama("http://127.0.0.1:11434", {
      fetchFn: refused,
      timeoutMs: 200,
    })
    expect(result).toEqual({ running: false, version: null, models: [] })
  })

  it("aborts a hanging server within the timeout instead of waiting forever", async () => {
    const hang: OllamaFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        )
      })
    const started = Date.now()
    const result = await probeOllama("http://127.0.0.1:11434", {
      fetchFn: hang,
      timeoutMs: 50,
    })
    expect(result.running).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("returns version and installed models when the server answers", async () => {
    const fetchFn: OllamaFetch = async (url) => {
      if (url.endsWith("/api/version")) {
        return { ok: true, json: async () => ({ version: "0.5.4" }) }
      }
      expect(url).toBe("http://box:11434/api/tags")
      return {
        ok: true,
        json: async () => ({ models: [{ name: "llama3.2:latest" }] }),
      }
    }
    const result = await probeOllama("http://box:11434", { fetchFn })
    expect(result).toEqual({
      running: true,
      version: "0.5.4",
      models: [{ id: "llama3.2:latest", label: "llama3.2:latest" }],
    })
  })

  it("still counts as running when only the tags call fails", async () => {
    const fetchFn: OllamaFetch = async (url) => {
      if (url.endsWith("/api/version")) {
        return { ok: true, json: async () => ({ version: "0.5.4" }) }
      }
      throw new Error("boom")
    }
    const result = await probeOllama("http://box:11434", { fetchFn })
    expect(result).toEqual({ running: true, version: "0.5.4", models: [] })
  })
})

describe("OllamaAdapter.send", () => {
  it("posts the conversation and streams deltas through to done", async () => {
    let requestUrl = ""
    let requestBody = ""
    const fetchFn = (async (url: unknown, init: unknown) => {
      requestUrl = String(url)
      requestBody = String((init as { body: string }).body)
      return streamingResponse([
        '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
        "not json at all\n",
        '{"message":{"role":"assistant","content":" world"},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":7,"eval_count":9,"total_duration":2000000000}\n',
      ])
    }) as unknown as typeof fetch

    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    await adapter.send("s1", "hi", cb, {
      model: "llama3.2",
      baseUrl: "http://box:11434/",
      systemPrompt: "be brief",
      history: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    })

    expect(requestUrl).toBe("http://box:11434/api/chat")
    expect(JSON.parse(requestBody)).toEqual({
      model: "llama3.2",
      stream: true,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "hi" },
      ],
    })
    expect(textOf(cb)).toBe("Hello world")
    expect(statusesOf(cb)).toEqual(["idle", "running", "done"])
    expect(endedReasonsOf(cb)).toEqual(["done"])
    expect(cb.onStreamDone).toHaveBeenCalledTimes(1)
    expect(cb.onUsage).toHaveBeenCalledWith(
      "s1",
      { inputTokens: 7, outputTokens: 9, durationMs: 2000 },
      cb.onMessage.mock.calls[0][0].id,
    )
  })

  it("writes a reachability message into the transcript when the server is down", async () => {
    const fetchFn = (async () => {
      throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") })
    }) as unknown as typeof fetch

    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    await adapter.send("s1", "hi", cb, { model: "llama3.2" })

    expect(textOf(cb)).toContain("Ollama is not reachable at http://127.0.0.1:11434")
    expect(textOf(cb)).toContain("ollama serve")
    expect(statusesOf(cb)).toEqual(["idle", "running", "error"])
    expect(endedReasonsOf(cb)).toEqual(["error"])
    expect(cb.onStreamDone).toHaveBeenCalledTimes(1)
  })

  it("surfaces the server's own error body on a non-200 response", async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 404,
      body: null,
      text: async () => '{"error":"model \'ghost\' not found"}',
    })) as unknown as typeof fetch

    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    await adapter.send("s1", "hi", cb, { model: "ghost" })

    expect(textOf(cb)).toContain("model 'ghost' not found")
    expect(statusesOf(cb)).toEqual(["idle", "running", "error"])
  })

  it("refuses to run without a model", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    await adapter.send("s1", "hi", cb, {})

    expect(fetchFn).not.toHaveBeenCalled()
    expect(textOf(cb)).toContain("No model selected")
    expect(statusesOf(cb)).toEqual(["idle", "running", "error"])
  })

  it("keeps what already streamed and lands on idle after an abort", async () => {
    const fetchFn = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal: AbortSignal }).signal
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield '{"message":{"role":"assistant","content":"partial"},"done":false}\n'
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")))
          })
        })(),
        text: async () => "",
      }
    }) as unknown as typeof fetch

    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    const turn = adapter.send("s1", "hi", cb, { model: "llama3.2" })
    await vi.waitFor(() => {
      expect(cb.onDelta).toHaveBeenCalled()
    })
    await adapter.abort("s1")
    await turn

    expect(textOf(cb)).toBe("partial")
    expect(statusesOf(cb)).toEqual(["idle", "running", "idle"])
    expect(endedReasonsOf(cb)).toEqual([])
    expect(cb.onStreamDone).toHaveBeenCalledTimes(1)
  })

  it("rejects a second send while a turn is still running", async () => {
    const fetchFn = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal: AbortSignal }).signal
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield '{"message":{"role":"assistant","content":"x"},"done":false}\n'
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")))
          })
        })(),
        text: async () => "",
      }
    }) as unknown as typeof fetch

    const adapter = new OllamaAdapter(fetchFn)
    const cb = callbacks()
    await adapter.start({ sessionId: "s1", cwd: "/tmp" }, cb)
    const turn = adapter.send("s1", "hi", cb, { model: "llama3.2" })
    await vi.waitFor(() => {
      expect(cb.onDelta).toHaveBeenCalled()
    })
    await expect(adapter.send("s1", "again", cb, { model: "llama3.2" })).rejects.toThrow(
      /already running/,
    )
    await adapter.abort("s1")
    await turn
  })
})

describe("renderOllamaFailure", () => {
  it("labels connection failures with the base url and includes the cause", () => {
    const text = renderOllamaFailure(
      "http://box:11434",
      new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
    )
    expect(text).toContain("not reachable at http://box:11434")
    expect(text).toContain("connect ECONNREFUSED")
  })

  it("keeps other errors generic", () => {
    const text = renderOllamaFailure("http://box:11434", new Error("model exploded"))
    expect(text).toContain("could not complete this turn")
    expect(text).toContain("model exploded")
  })
})
