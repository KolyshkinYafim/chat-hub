# Chat Hub

> Multi-chat cockpit for AI coding agents (Grok, Claude Code, Codex, OpenCode).

Electron (macOS first) · TypeScript · React · pnpm

## What it is

Full **chat shell**:

- many chats / sessions in parallel
- sidebar + transcript UI
- pluggable provider adapters
- honest session status from an event bus (never stuck “Working” without a process)
- optional event bridge for **Session Monitor**

## Run

```bash
pnpm install
pnpm dev
```

Requirements: Node ≥ 20, pnpm, macOS (primary).

## What works (MVP)

- Electron main + React renderer
- Sidebar session list, create / select / delete
- Chat transcript (user / assistant) with mock streaming
- `SessionManager` + **mock** adapter (status + stream events)
- Status only from event bus; restored sessions never stay `running`
- OS notifications on `waiting_input` / `done`
- Local persistence of sessions + messages
- Provider select: mock live; grok / claude / codex / opencode placeholders
- Session Monitor bridge: JSONL events (see [docs/bridge.md](./docs/bridge.md))

## Docs

- [Product](./docs/product.md)
- [Architecture](./docs/architecture.md)
- [MVP checklist](./docs/mvp.md)
- [Providers](./docs/providers.md)
- [Bridge contract](./docs/bridge.md)

## Data locations

| What | Where |
|------|--------|
| Sessions + messages | `~/Library/Application Support/chat-hub/data/state.json` |
| Session Monitor bridge (JSONL) | `~/Library/Application Support/agent-desktop/events.jsonl` |

## Session Monitor bridge

Chat Hub **appends** `SessionEvent` lines to the shared JSONL file above. Session Monitor tails the same path.

- Contract: see [docs/bridge.md](./docs/bridge.md) and both apps’ architecture docs
- Override path: `AGENT_DESKTOP_EVENTS=/path/to/events.jsonl`
- Both apps run alone; the bridge is best-effort

## Provider next steps

1. Implement one real `AgentAdapter` (Grok Build CLI or OpenCode) behind the existing interface in `src/main/adapters/`.
2. Keep emitting `SessionEvent` through `SessionManager` so UI + bridge stay unchanged.
3. Add second provider only after the first real chat loop is solid.

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Electron + Vite HMR |
| `pnpm build` | Production build to `out/` |
| `pnpm typecheck` | `tsc` for main/preload + renderer |
