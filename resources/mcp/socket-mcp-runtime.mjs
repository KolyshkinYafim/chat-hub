import { connect } from "node:net"
import { randomUUID } from "node:crypto"

export function textResult(text) {
  return { content: [{ type: "text", text }] }
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true }
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== ""
}

export function createMcpRuntime(config) {
  const {
    tag,
    unavailableCode,
    socketEnv,
    sessionEnv,
    opTimeoutMs,
    timeoutMarginMs,
    serverName,
    serverVersion,
    defaultProtocolVersion,
    knownProtocolVersions,
    tools,
    unreachableFor,
    shapeResult,
    validateExtra,
  } = config

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  function toolCatalogue() {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  }

  function unavailableError(cause) {
    const err = new Error(unreachableFor(tools[0]))
    err.code = unavailableCode
    if (cause) err.cause = cause
    return err
  }

  let socket = null
  let connecting = null
  let socketBuffer = ""
  const pending = new Map()

  function failPending(err) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
  }

  function settleResponse(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(`[${tag}] unparsable socket line\n`)
      return
    }
    const entry =
      message && typeof message.id === "string"
        ? pending.get(message.id)
        : undefined
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  function consumeSocketChunk(chunk) {
    socketBuffer += chunk
    let index = socketBuffer.indexOf("\n")
    while (index !== -1) {
      const line = socketBuffer.slice(0, index).replace(/\r$/, "")
      socketBuffer = socketBuffer.slice(index + 1)
      if (line.trim()) settleResponse(line)
      index = socketBuffer.indexOf("\n")
    }
  }

  function ensureSocket() {
    if (socket && !socket.destroyed) return Promise.resolve(socket)
    if (connecting) return connecting
    const path = process.env[socketEnv] ?? ""
    if (!path) return Promise.reject(unavailableError())

    connecting = new Promise((resolveSocket, rejectSocket) => {
      const next = connect(path)
      let opened = false
      next.setEncoding("utf8")
      next.on("connect", () => {
        opened = true
        socket = next
        socketBuffer = ""
        connecting = null
        resolveSocket(next)
      })
      next.on("data", (chunk) => consumeSocketChunk(chunk))
      next.on("error", (err) => {
        next.destroy()
        if (!opened) {
          connecting = null
          rejectSocket(unavailableError(err))
        }
      })
      next.on("close", () => {
        if (socket === next) {
          socket = null
          socketBuffer = ""
        }
        if (!opened) {
          connecting = null
          rejectSocket(unavailableError())
        }
        failPending(unavailableError())
      })
    })
    return connecting
  }

  function closeSocket() {
    if (socket) socket.destroy()
    socket = null
    connecting = null
  }

  async function callHub(op, params) {
    const open = await ensureSocket()
    const id = randomUUID()
    const request = {
      id,
      sessionId: process.env[sessionEnv] ?? "",
      op,
      params,
    }
    const budget = opTimeoutMs + timeoutMarginMs
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectCall(
          new Error(`Chat Hub did not answer ${op} within ${budget} ms.`),
        )
      }, budget)
      if (typeof timer.unref === "function") timer.unref()
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
      open.write(`${JSON.stringify(request)}\n`, (err) => {
        if (!err) return
        pending.delete(id)
        clearTimeout(timer)
        rejectCall(unavailableError(err))
      })
    })
  }

  function validateArgs(tool, args) {
    for (const key of tool.inputSchema.required ?? []) {
      if (!isPresent(args[key])) return `${tool.name} requires "${key}".`
    }
    return validateExtra ? validateExtra(tool, args, isPresent) : null
  }

  function buildParams(tool, args) {
    const params = {}
    for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
      if (args[key] !== undefined) params[key] = args[key]
    }
    return params
  }

  async function callTool(name, rawArgs) {
    const tool = toolsByName.get(name)
    if (!tool) return null
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs
        : {}
    const invalid = validateArgs(tool, args)
    if (invalid) return errorResult(invalid)

    let response
    try {
      response = await callHub(tool.op, buildParams(tool, args))
    } catch (err) {
      if (err && err.code === unavailableCode) {
        return errorResult(unreachableFor(tool))
      }
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    if (!response || response.ok !== true) {
      const detail =
        response && typeof response.error === "string"
          ? response.error
          : "unknown error"
      return errorResult(`${name} failed: ${detail}`)
    }
    const result =
      response.result &&
      typeof response.result === "object" &&
      !Array.isArray(response.result)
        ? response.result
        : {}
    return shapeResult(tool, result)
  }

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result })
  }

  function replyError(id, code, message) {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
  }

  function initializeResult(params) {
    const asked =
      params && typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : ""
    return {
      protocolVersion: knownProtocolVersions.has(asked)
        ? asked
        : defaultProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: serverVersion },
    }
  }

  async function dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      replyError(null, -32600, "Invalid Request")
      return
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    if (typeof method !== "string") {
      if (!isNotification) replyError(id, -32600, "Invalid Request")
      return
    }

    switch (method) {
      case "initialize":
        if (!isNotification) reply(id, initializeResult(params))
        return
      case "notifications/initialized":
      case "notifications/cancelled":
        return
      case "ping":
        if (!isNotification) reply(id, {})
        return
      case "tools/list":
        if (!isNotification) reply(id, { tools: toolCatalogue() })
        return
      case "tools/call": {
        if (isNotification) return
        const name = params && typeof params.name === "string" ? params.name : ""
        const result = await callTool(name, params?.arguments)
        if (!result) {
          replyError(id, -32602, `Unknown tool: ${name || "(missing name)"}`)
          return
        }
        reply(id, result)
        return
      }
      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`)
    }
  }

  function main() {
    let stdinBuffer = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      stdinBuffer += chunk
      let index = stdinBuffer.indexOf("\n")
      while (index !== -1) {
        const line = stdinBuffer.slice(0, index).replace(/\r$/, "")
        stdinBuffer = stdinBuffer.slice(index + 1)
        index = stdinBuffer.indexOf("\n")
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          replyError(null, -32700, "Parse error")
          continue
        }
        void dispatch(message).catch((err) => {
          process.stderr.write(`[${tag}] dispatch failed: ${String(err)}\n`)
        })
      }
    })
    process.stdin.on("end", () => {
      closeSocket()
      process.exit(0)
    })
    process.on("uncaughtException", (err) => {
      process.stderr.write(`[${tag}] ${String(err)}\n`)
    })
  }

  return { main }
}
