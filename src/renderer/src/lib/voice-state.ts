/**
 * Composer dictation button state. Handy records and pastes on its own; all
 * the button can honestly know is what it asked for and what the textarea saw,
 * so the phases are: idle → recording (toggle accepted) → waiting (stop asked,
 * transcription in flight) → idle (text landed, or we stopped believing).
 */
export type VoicePhase = "idle" | "recording" | "waiting"

export type VoiceEvent =
  | { type: "toggle-accepted" }
  | { type: "toggle-failed" }
  | { type: "stop-requested" }
  | { type: "text-arrived" }
  | { type: "cancelled" }
  | { type: "timed-out" }
  | { type: "window-blurred" }

/** A transcription that never pastes must not wedge the button in "waiting". */
export const VOICE_WAIT_TIMEOUT_MS = 15_000

/**
 * What a click on the button asks Handy for. Waiting means a transcription is
 * already in flight — another toggle would start a fresh recording under a
 * button that claims to be finishing one, so the click means nothing.
 */
export function voiceToggleIntent(phase: VoicePhase): "start" | "stop" | null {
  if (phase === "waiting") return null
  return phase === "idle" ? "start" : "stop"
}

export function nextVoicePhase(
  phase: VoicePhase,
  event: VoiceEvent,
): VoicePhase {
  switch (event.type) {
    case "toggle-accepted":
      return phase === "idle" ? "recording" : phase
    case "stop-requested":
      return phase === "recording" ? "waiting" : phase
    case "toggle-failed":
    case "cancelled":
      return "idle"
    case "text-arrived":
    case "timed-out":
      return phase === "waiting" ? "idle" : phase
    case "window-blurred":
      // Recording survives blur — Handy is global and the user may be dictating
      // into another app. Waiting cannot: the paste lands wherever focus went,
      // so the button resets rather than promise text that will never arrive.
      return phase === "waiting" ? "idle" : phase
  }
}
