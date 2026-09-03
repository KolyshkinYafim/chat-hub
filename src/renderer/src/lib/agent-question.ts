import { oneLine } from "@shared/text"
import type { AgentInputRequestInfo, ChatMessage } from "@shared/types"
import { describeItem } from "@shared/live"

/**
 * A CLI question, resolved into everything the card has to draw: the topic, the
 * question itself, what each option decides, and whether an answer in the
 * owner's own words is allowed at all.
 */
export type QuestionCard = {
  id: string
  /** Short topic above the question; null when the header only restates it. */
  topic: string | null
  prompt: string
  options: QuestionOption[]
  /** The CLI wants a secret — the field masks it and no answer is echoed. */
  secret: boolean
  /** Free text is an acceptable answer; always so when there is no option. */
  allowOther: boolean
}

export type QuestionOption = {
  label: string
  /** What picking this decides; null when the CLI sent no description. */
  description: string | null
}

/**
 * One question's in-progress answer. `text` survives picking an option so
 * switching back and forth never loses what was already typed.
 */
export type QuestionAnswer = {
  choice: string | null
  text: string
  /** True once the owner switched to writing the answer themselves. */
  own: boolean
}

export type QuestionContext = {
  /** The agent's own last words before it asked. */
  lead: string | null
  /** What it had just done, oldest first. */
  steps: string[]
}

export const EMPTY_ANSWER: QuestionAnswer = {
  choice: null,
  text: "",
  own: false,
}

const LEAD_MAX = 240
const DETAIL_MAX = 64
const STEP_MAX = 3

export function toQuestionCards(
  request: AgentInputRequestInfo,
): QuestionCard[] {
  return request.questions.map((question) => {
    const header = question.header.trim()
    const prompt =
      question.prompt.trim() || header || "The agent needs an answer to continue."
    const options: QuestionOption[] = (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description?.trim() || null,
    }))
    return {
      id: question.id,
      topic: header && !restates(header, prompt) ? header : null,
      prompt,
      options,
      secret: question.secret === true,
      allowOther: question.allowOther ?? options.length === 0,
    }
  })
}

/**
 * Who is asking, for the card's kicker. An MCP server asks under its own name
 * rather than under the protocol's ("Docs (MCP) asks", not "Mcp asks").
 */
export function askerLabel(source: string): string {
  const [head = "", ...rest] = source.split(":")
  const server = rest.join(":").trim()
  if (head === "mcp" && server) return `${capitalize(server)} (MCP) asks`
  return `${capitalize(head.trim() || "Agent")} asks`
}

/** The answer this question would send right now; "" while unanswered. */
export function answerValue(
  card: QuestionCard,
  answer: QuestionAnswer | undefined,
): string {
  const state = answer ?? EMPTY_ANSWER
  if (state.own || card.options.length === 0) return state.text.trim()
  return state.choice ?? ""
}

export function answersReady(
  cards: QuestionCard[],
  answers: Record<string, QuestionAnswer>,
): boolean {
  return (
    cards.length > 0 &&
    cards.every((card) => answerValue(card, answers[card.id]) !== "")
  )
}

/** The shape the broker resolves a request with: one id → one answer. */
export function answerPayload(
  cards: QuestionCard[],
  answers: Record<string, QuestionAnswer>,
): Record<string, string[]> {
  return Object.fromEntries(
    cards.map((card) => [card.id, [answerValue(card, answers[card.id])]]),
  )
}

/**
 * What the agent was doing when it stopped to ask. The question card sits above
 * the transcript, so without this the turn it belongs to may be off-screen.
 */
export function questionContext(
  message: ChatMessage | null | undefined,
): QuestionContext {
  if (!message || message.role !== "assistant") return { lead: null, steps: [] }
  return { lead: leadOf(message.content), steps: stepsOf(message.items) }
}

/** A header that only restates the question is noise sitting above it. */
function restates(header: string, prompt: string): boolean {
  const head = flatten(header)
  const body = flatten(prompt)
  return head === body || body.startsWith(head)
}

function flatten(value: string): string {
  return value.toLowerCase().replace(/[\s?.:,]+/g, " ").trim()
}

function leadOf(content: string): string | null {
  const prose = content.replace(/```[\s\S]*?(?:```|$)/g, "\n")
  const lines = prose
    .split("\n")
    .map((line) => plain(line))
    .filter(Boolean)
  const last = lines[lines.length - 1]
  return last ? oneLine(last, LEAD_MAX) : null
}

function stepsOf(items: ChatMessage["items"]): string[] {
  const done: string[] = []
  for (const item of items ?? []) {
    if (item.kind === "reasoning" || item.status === "pending") continue
    const { label, detail } = describeItem(item)
    const line = detail ? `${label} · ${oneLine(detail, DETAIL_MAX)}` : label
    if (line !== done[done.length - 1]) done.push(line)
  }
  return done.slice(-STEP_MAX)
}

/** Markdown the lead line carries reads as punctuation once it is plain text. */
function plain(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]\s+|#{1,6}\s+|>\s+)/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim()
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
