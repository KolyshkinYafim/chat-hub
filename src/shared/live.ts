import { splitToolName, summarizeToolArgs } from "./tool-card"
import type { AgentTurnItem, LivePhase } from "./types"

export const phaseLabel: Record<LivePhase, string> = {
  connecting: "Connecting",
  thinking: "Thinking",
  tool: "Running a tool",
}

const SHELL_WRAP =
  /^\S*\b(?:bash|zsh|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/

export function unwrapShell(command: string): string {
  const wrapped = SHELL_WRAP.exec(command.trim())
  return wrapped ? wrapped[2]!.trim() : command
}

export function describeItem(item: AgentTurnItem): {
  label: string
  detail: string
  server: string | null
} {
  const plain = (label: string, detail: string) => ({ label, detail, server: null })
  switch (item.kind) {
    case "command":
      return plain("Shell", unwrapShell(item.command.split("\n")[0] ?? ""))
    case "tool": {
      const { label, server } = splitToolName(item.name)
      return { label, detail: summarizeToolArgs(item.arguments), server }
    }
    case "file_change": {
      const paths = item.changes.map((change) => change.path)
      if (paths.length === 1) return plain("Edit", paths[0]!)
      return plain("Edit", paths.length ? `${paths.length} files` : "code diff")
    }
    case "plan": {
      const active =
        item.steps?.find((step) => step.status === "running") ??
        item.steps?.find((step) => step.status === "pending")
      return plain("Plan", active?.text || item.text)
    }
    case "subagent": {
      const open = item.steps?.find((step) => step.status === "running")
      const detail =
        [open?.label, open?.detail].filter(Boolean).join(" · ") ||
        item.description ||
        `${item.steps?.length ?? 0} steps`
      return plain(`${item.name} agent`, detail)
    }
    case "web_search":
      return plain("Search", item.query)
    case "image":
      return plain("Image", item.path)
    case "review":
      return plain("Review", item.text)
    case "compaction":
      return plain("Compacting context", compactionDetail(item))
    case "reasoning":
      return plain("Reasoning", "")
    case "notice":
      return plain(
        item.level === "warning" ? "Warning" : "Note",
        item.detail ? `${item.title} · ${item.detail}` : item.title,
      )
    case "error":
      return plain("Error", item.message)
    default:
      return plain("Step", "")
  }
}

function compactionDetail(item: AgentTurnItem & { kind: "compaction" }): string {
  if (item.preTokens === undefined) return ""
  const to = item.postTokens === undefined ? "" : ` → ${formatTokens(item.postTokens)}`
  return `${formatTokens(item.preTokens)}${to} tokens`
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count)
}
