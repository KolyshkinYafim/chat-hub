import type { ChatMessage } from "@shared/types"

/**
 * Keys `ChatMessage` used to carry. They are still sitting in every state.json
 * and archive.jsonl written before the field was removed, where they are dead
 * weight the next save would faithfully write out again — so both readers drop
 * them on the way in and the file loses them the first time it is rewritten.
 */
type LegacyChatMessage = ChatMessage & { touchedFiles?: unknown }

export function dropLegacyMessageFields(message: ChatMessage): ChatMessage {
  const legacy = message as LegacyChatMessage
  if (!("touchedFiles" in legacy)) return message
  const { touchedFiles: _dropped, ...rest } = legacy
  void _dropped
  return rest
}

export function dropLegacyMessageFieldsIn(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.map(dropLegacyMessageFields)
}
