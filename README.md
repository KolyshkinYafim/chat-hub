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

## Install (daily driver)

Builds the app, puts it in `/Applications`, and starts it at login — no terminal needed afterwards:

```bash
pnpm install:mac              # add --no-login to skip launch-at-login
pnpm status:mac               # does /Applications match this working tree?
pnpm uninstall:mac            # remove app + LaunchAgent (data is kept)
```

Every build stamps its identity — version, commit (`-dirty` when the tree has uncommitted
changes) and UTC timestamp — into `Contents/Info.plist` (`AgentDesktopBuildCommit`,
`AgentDesktopBuildDate`) and into `out/build-info.json` inside the app bundle, which is what
`pnpm status:mac` compares against. Session Monitor can then focus a real installed app instead
of asking you to run `pnpm dev`.

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

1. **⚙ Settings** (`⌘,`) → **Providers & accounts** — see Connected / Needs login, **Login…**, default model
2. Select agent + **model** chips in composer
3. **New session** → pick your repo folder
4. Send a prompt — CLI runs with `--model` + YOLO permissions
5. **Stop** / **Open** / **Commit** as needed

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

## Permissions (default: **YOLO**)

Daily driver default is **full bypass** so agents don't stop on every tool:

| Mode (composer chip) | Claude | Grok | OpenCode |
|----------------------|--------|------|----------|
| **YOLO** (default) | `--permission-mode bypassPermissions` + `--dangerously-skip-permissions` | `bypassPermissions` + `--always-approve` | `--dangerously-skip-permissions` |
| **Edits** | `acceptEdits` | `acceptEdits` | CLI prompts (OpenCode has no edits-only CLI mode) |
| **Ask** | `default` | `default` | CLI prompts |

Persisted in `userData/data/settings.json`. Override bootstrap with `CHAT_HUB_PERMISSION=yolo|acceptEdits|default`.

## Env knobs

| Env | Effect |
|-----|--------|
| `CHAT_HUB_DEMO=1` | Seed multi-project demo data on empty store |
| `CHAT_HUB_PERMISSION` | Default permission mode if settings missing |

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
| `pnpm test` | Vitest unit suite (`tests/`) |
| `pnpm pack:mac` | Build `release/mac-*/Chat Hub.app` with build identity |
| `pnpm dist:mac` | Same, as a `.dmg` |
| `pnpm install:mac` | Build + install to `/Applications` + launch at login |
| `pnpm status:mac` | Compare the installed app with this working tree |
| `pnpm uninstall:mac` | Remove the app and its LaunchAgent |
