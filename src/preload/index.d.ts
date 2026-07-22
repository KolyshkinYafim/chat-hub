import type { ChatHubApi } from "./index"

declare global {
  interface Window {
    chatHub: ChatHubApi
  }
}

export {}
