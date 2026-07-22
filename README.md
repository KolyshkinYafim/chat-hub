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

- Electron main + React T3-class workbench UI
- Multi-project sidebar, create / select / delete
- **Real CLI adapters** (auto-detected on PATH):
  - **Claude Code** (`claude -p --output-format stream-json`)
  - **Grok Build** (`grok --single --output-format streaming-json`)
  - **OpenCode** (`opencode run --format json`)
  - **Codex** when `codex` is installed
  - Mock (UI testing)
- Folder picker for real project `cwd`
- Open folder / editor, git branch footer, simple Commit
- Status only from events/process exit (never stuck Running after restart)
- OS notifications + Session Monitor JSONL bridge
- Local persistence of sessions + messages

### Daily driver loop

1. Select agent (Claude / Grok / OpenCode)
2. **New session** → pick your repo folder
3. Send a prompt — CLI runs in that folder, stream shows in transcript
4. **Stop** aborts the process; **Open** / **Commit** for local workflow

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

## Env knobs

| Env | Effect |
|-----|--------|
| `CHAT_HUB_DEMO=1` | Seed multi-project demo data on empty store |
| `CHAT_HUB_CLAUDE_PERMISSION` | Claude `--permission-mode` (default `acceptEdits`) |
| `CHAT_HUB_GROK_PERMISSION` | Grok permission mode (default `acceptEdits`) |
| `CHAT_HUB_OPENCODE_AUTO=1` | Pass `--auto` to OpenCode (auto-approve tools) |

## Provider next steps

1. Richer stream parsers (tool cards, diffs, permission prompts in UI)
2. Codex flag surface once you install `codex`
3. Attach files / model picker wired to CLI flags
See [docs/usability-checklist.md](./docs/usability-checklist.md).

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Electron + Vite HMR |
| `pnpm build` | Production build to `out/` |
| `pnpm typecheck` | `tsc` for main/preload + renderer |
