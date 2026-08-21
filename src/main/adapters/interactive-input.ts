import type { AgentInputQuestion } from "@shared/types"

/**
 * Claude Code and Grok Build run here as one-shot, headless CLI turns. Unlike
 * Codex app-server they cannot suspend stdin mid-turn, so they opt into this
 * small output protocol: finish a safe turn, ask in the Hub, then resume the
 * CLI session with the user's answer. The marker is stripped before it reaches
 * the transcript.
 */
const OPEN = "<chat-hub-question>"
const CLOSE = "</chat-hub-question>"

export type InteractiveQuestion = {
  questions: AgentInputQuestion[]
}

export const INTERACTIVE_INPUT_INSTRUCTION = `
When you genuinely need a decision or missing fact from the user, do not guess
and do not start irreversible work. Finish your current safe step, then end the
response with exactly this machine-readable block (and no text after it):
<chat-hub-question>{"header":"Short topic","prompt":"Your question","options":[{"label":"Option A","description":"Why"}]}</chat-hub-question>
Use one question per block. The Chat Hub will show it as a form and resume this
same session with the answer. Do not use the block merely to suggest a follow-up.
`.trim()

export function appendInteractiveInputInstruction(systemPrompt?: string): string {
  return [systemPrompt?.trim(), INTERACTIVE_INPUT_INSTRUCTION]
    .filter(Boolean)
    .join("\n\n")
}

/** Incrementally hides a possible marker while regular text keeps streaming. */
export class InteractiveQuestionStream {
  private pending = ""

  push(delta: string): string {
    this.pending += delta
    const start = this.pending.indexOf(OPEN)
    if (start !== -1) {
      const visible = this.pending.slice(0, start)
      this.pending = this.pending.slice(start)
      return visible
    }

    // Keep only the suffix that may be the beginning of a split marker.
    const keep = matchingPrefixLength(this.pending, OPEN)
    const visible = this.pending.slice(0, this.pending.length - keep)
    this.pending = this.pending.slice(this.pending.length - keep)
    return visible
  }

  finish(): { visible: string; question: InteractiveQuestion | null } {
    if (!this.pending) return { visible: "", question: null }
    const pending = this.pending
    const parsed = parseInteractiveQuestion(pending)
    this.pending = ""
    return parsed
      ? { visible: "", question: parsed }
      : { visible: pending, question: null }
  }
}

export function parseInteractiveQuestion(value: string): InteractiveQuestion | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null
  const json = trimmed.slice(OPEN.length, -CLOSE.length).trim()
  try {
    const raw = JSON.parse(json) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    const prompt = string(item.prompt)
    if (!prompt) return null
    const options: AgentInputQuestion["options"] = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) return []
          const value = option as Record<string, unknown>
          const label = string(value.label)
          if (!label) return []
          const description = string(value.description)
          return [description ? { label, description } : { label }]
        })
      : undefined
    return {
      questions: [{
        id: "answer",
        header: string(item.header) || "Question",
        prompt,
        options: options?.length ? options : undefined,
        // The answer is fed back as prose on the next turn, so anything the
        // owner writes is as usable to the CLI as one of its own labels.
        allowOther: true,
      }],
    }
  } catch {
    return null
  }
}

export function formatInteractiveAnswer(
  question: InteractiveQuestion,
  answers: Record<string, string[]>,
): string {
  const lines = question.questions.map((item) => {
    const values = answers[item.id] ?? []
    return `- ${item.header}: ${values.join(", ") || "(no answer)"}`
  })
  return `User answer to your question:\n${lines.join("\n")}\n\nContinue the task using this answer. Do not repeat the question.`
}

function matchingPrefixLength(value: string, prefix: string): number {
  const max = Math.min(value.length, prefix.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) return length
  }
  return 0
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
