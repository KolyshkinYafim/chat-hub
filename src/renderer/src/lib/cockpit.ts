import { parseCockpitSearch, type CockpitWindow } from "@shared/cockpit"

export type { CockpitWindow }

export function readCockpitWindow(): CockpitWindow {
  if (typeof window === "undefined") {
    return { enabled: false, vibrancy: "under-window" }
  }
  const fromSearch = parseCockpitSearch(window.location.search)
  const fromApi =
    "chatHub" in window && window.chatHub.cockpit === true
  return {
    enabled: fromApi || fromSearch.enabled,
    vibrancy: fromSearch.vibrancy,
  }
}
