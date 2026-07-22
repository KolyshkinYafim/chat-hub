# Session Monitor bridge

Chat Hub is a **producer** of `SessionEvent` for Session Monitor.

## File path (shared)

On macOS:

```
~/Library/Application Support/agent-desktop/events.jsonl
```

Override with env `AGENT_DESKTOP_EVENTS` if needed.

Exact path is shown in the Chat Hub sidebar footer and via IPC `bridge:path`.

## Format

Append-only **JSONL**. One event per line:

```json
{"type":"session.upsert","session":{...},"ts":1710000000000}
{"type":"session.status","id":"...","status":"running","ts":1710000000100}
{"type":"session.message","id":"...","role":"assistant","preview":"...","ts":...}
{"type":"session.ended","id":"...","reason":"done","ts":...}
```

`ts` is Hub-added wall-clock ms (optional for consumers). Core fields match the shared `SessionEvent` contract in both apps’ architecture docs.

## SessionEvent types

- `session.upsert`
- `session.status` — `idle` | `running` | `waiting_input` | `error` | `done`
- `session.permission`
- `session.question`
- `session.message`
- `session.ended`

## Consumer notes

- Session Monitor tails this file (replay on start, then append-only).
- Do not truncate without coordination.
- Status must never be inferred as `running` without a live process (Hub resets `running` → `idle` on restart).
- Both apps run alone: Hub writes even if Monitor is absent; Monitor still shows mock sessions if Hub is absent.
