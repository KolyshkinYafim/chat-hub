# Chat Hub — Architecture

## High level

```
┌──────────────────────────────────┐
│ Renderer                         │
│  sidebar sessions | chat | tools │
└────────────────┬─────────────────┘
                 │ IPC
┌────────────────▼─────────────────┐
│ Main: SessionManager             │
│  create/list/kill sessions       │
│  route messages                  │
│  publish SessionEvent            │
└────────────────┬─────────────────┘
                 │
     ┌───────────┼───────────┬────────────┐
     ▼           ▼           ▼            ▼
  AdapterGrok AdapterClaude AdapterCodex AdapterOpenCode
```

## Adapter interface (sketch)

```ts
interface AgentAdapter {
  id: "grok" | "claude" | "codex" | "opencode"
  start(opts: { cwd: string; title?: string }): Promise<SessionHandle>
  send(sessionId: string, message: string): Promise<void>
  abort(sessionId: string): Promise<void>
  onEvent(cb: (e: SessionEvent) => void): void
}
```

Prefer **official/headless APIs** over scraping TUI when available.

## SessionEvent

Same contract as Session Monitor (`session.status`, `session.permission`, …).

Hub is the **primary producer** for sessions it owns.

## Persistence

- transcripts: local SQLite or append-only JSONL per session
- meta: sessions index (provider, cwd, updatedAt, status)

## Security

- cwd sandbox awareness
- no auto-run destructive without policy
- secrets only in main / OS keychain later
