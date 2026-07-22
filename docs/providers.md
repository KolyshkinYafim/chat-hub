# Chat Hub — Providers

| Provider | Priority MVP | Integration notes |
|----------|--------------|-------------------|
| **Grok Build** | P0 or P1 | CLI / headless; subagents → child sessions in UI later |
| **OpenCode** | P0 or P1 | Desktop/CLI + plugins/events; good notif story |
| **Claude Code** | P1 | hooks / session files; widely used |
| **Codex CLI** | P1 | pair with Claude in many workflows |

## Adapter strategy

1. Start with **one** real provider you use daily
2. Keep `AgentAdapter` interface stable
3. Second provider only after MVP chat loop works
4. Monitor app discovers sessions via bridge, not by reimplementing each CLI

## Fake adapter

`mock` provider for UI development without API keys.
