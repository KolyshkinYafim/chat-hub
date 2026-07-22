import type { HubEvent, SessionEvent } from "@shared/types"

type Listener = (event: HubEvent) => void

export class EventBus {
  private listeners = new Set<Listener>()

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: HubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("[event-bus] listener error", err)
      }
    }
  }

  emitSession(event: SessionEvent): void {
    this.emit(event)
  }
}
