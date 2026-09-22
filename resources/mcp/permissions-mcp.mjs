import { connect } from "node:net"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

const tool = {
  name: "approve",
  description: "Ask the Chat Hub user to allow or deny this exact tool invocation.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
}

export function askPermission(args, env = process.env) {
  const deny = message => ({ behavior: "deny", message })
  if (!env.AGENT_DESKTOP_SOCKET || !env.AGENT_DESKTOP_HUB_SESSION || !args || typeof args.tool_name !== "string" || !args.input || typeof args.input !== "object" || Array.isArray(args.input)) {
    return Promise.resolve(deny("Chat Hub cannot display this permission request."))
  }
  return new Promise(resolve => {
    let settled = false
    let buffer = ""
    const socket = connect(env.AGENT_DESKTOP_SOCKET)
    const finish = decision => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(decision)
    }
    const timer = setTimeout(() => finish(deny("Permission request timed out.")), 300_000)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(JSON.stringify({
      v: 1, event: "PermissionRequest", source: "claude",
      sessionId: env.AGENT_DESKTOP_HUB_SESSION, requestId: randomUUID(),
      summary: `${args.tool_name} · ${typeof args.input.command === "string" ? args.input.command : JSON.stringify(args.input)}`.slice(0, 2000),
      payload: { cwd: env.CHAT_HUB_PERMISSION_CWD, tool_name: args.tool_name, tool_input: args.input },
    }) + "\n"))
    socket.on("data", data => {
      buffer += data
      if (buffer.length > 64_000) return finish(deny("Invalid permission response."))
      const end = buffer.indexOf("\n")
      if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        finish(response?.decision?.behavior === "allow" ? { behavior: "allow", updatedInput: args.input } : deny("The user denied this tool invocation."))
      } catch { finish(deny("Invalid permission response.")) }
    })
    socket.on("error", () => finish(deny("Chat Hub permission UI is unavailable.")))
    socket.on("close", () => finish(deny("Permission request was closed without approval.")))
  })
}

export async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "chathub-permissions", version: "1.0.0" } }
  if (message.method === "tools/list") return { tools: [tool] }
  if (message.method === "ping") return {}
  if (message.method === "tools/call" && message.params?.name === "approve") {
    return { content: [{ type: "text", text: JSON.stringify(await askPermission(message.params.arguments)) }] }
  }
  throw new Error("Unknown permission MCP method")
}

if (process.argv[1]?.endsWith("permissions-mcp.mjs")) {
  const input = createInterface({ input: process.stdin })
  input.once("close", () => process.exit(0))
  input.on("line", line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id === undefined || message.id === null) return
    void handle(message).then(result => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
    }, () => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Permission request failed" } }) + "\n")
    })
  })
}
