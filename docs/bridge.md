# Session Monitor bridge

Chat Hub is a **producer** of `SessionEvent` for Session Monitor.

## File path

On macOS (Electron `userData`):

```
~/Library/Application Support/chat-hub/bridge/session-events.jsonl
```

Exact path is also shown in the Chat Hub sidebar footer and available via IPC `bridge:path`.

## Format

Append-only **JSONL**. One event per line:

```json
{"type":"session.upsert","session":{...},"ts":1710000000000}
{"type":"session.status","id":"...","status":"running","ts":1710000000100}
{"type":"session.message","id":"...","role":"assistant","preview":"...","ts":...}
{"type":"session.ended","id":"...","reason":"done","ts":...}
```

`ts` is Hub-added wall-clock ms. Core fields match the shared contract in Session Monitor `docs/architecture.md`.

## SessionEvent types

- `session.upsert`
- `session.status` — `idle` | `running` | `waiting_input` | `error` | `done`
- `session.permission`
- `session.question`
- `session.message`
- `session.ended`

## Consumer notes

- Tail the file; do not truncate from Monitor without coordination.
- Status must never be inferred as `running` without a live process (Hub resets `running` → `idle` on restart).
- Future: optional Unix socket at the same directory; JSONL remains the MVP contract.
