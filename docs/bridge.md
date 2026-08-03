# Chat Hub side of the bridge

The wire format, the trim lock and the permission socket are specified once, in
**[`session-monitor/docs/bridge.md`](../../session-monitor/docs/bridge.md)**. That document is
the authority. This one only records what the *Hub* does with it, and where in `src/` each
half lives.

If the two ever disagree, the Session Monitor doc is right and this one is a bug.

---

## Paths

| What | Default | Env override | Resolved by |
|------|---------|--------------|-------------|
| Event stream (Hub → Monitor) | `~/Library/Application Support/agent-desktop/events.jsonl` | `AGENT_DESKTOP_EVENTS` | `src/shared/bridge-path.ts` |
| Reverse channel (Monitor → Hub) | `…/agent-desktop/commands.jsonl` | `AGENT_DESKTOP_COMMANDS` | same |
| Island permission socket (Hub connects out) | `…/agent-desktop/monitor.sock` | `AGENT_DESKTOP_SOCKET` | same |
| Hub's own permission socket (CLIs connect in) | `…/agent-desktop/hub.sock` | `CHAT_HUB_SOCKET` | same |

All four live in one folder on purpose — `tests/shared.test.ts` asserts *"puts events and
commands side by side in one folder"* and *"honours the env override the Monitor and hooks
also read"*.

The events path is also shown in Settings → Connections, with file size and the age of the
last line.

---

## What the Hub publishes

`SessionManager.publishSessionEvent()` (`src/main/session-manager.ts`) is the single funnel:
one call feeds the in-process `EventBus` (→ renderer), the OS notification service, and
`SessionMonitorBridge.publish()` (`src/main/bridge.ts`), which appends
`JSON.stringify({...event, ts: Date.now()}) + "\n"`.

Four event types are actually constructed anywhere in `src/`:

| Event | When |
|-------|------|
| `session.upsert` | create, restore-on-boot, title/model/status metadata change |
| `session.status` | `idle` \| `running` \| `waiting_input` \| `error` \| `done` |
| `session.message` | user / assistant / system line, `preview` capped at 160 chars |
| `session.ended` | `done` \| `error` \| `killed` |

`session.permission` and `session.question` are in the `SessionEvent` union in
`src/shared/types.ts` but **the Hub never emits them**. They exist for the consumer side —
the Python hook writes `session.permission` into the same file directly. Hub permission
requests travel over the socket, not the JSONL (see below).

Two invariants the Hub owns:

- **No `running` without a live process.** `SessionManager.init()` rewrites any persisted
  `running` to `idle` and re-publishes `session.upsert` for every session on boot, so the
  island drops stale live dots. A 15 s watchdog (`WATCHDOG.intervalMs`) marks a `running`
  session `idle` when no turn is registered, and `error` after `WATCHDOG.silenceMs` =
  10 min of no output. Covered by `tests/session-manager.test.ts` → *"never leaves a session
  running with no live process"*, *"kills a turn that has gone silent past the timeout"*.
- **`waiting_input` is never emitted by a real adapter.** Only `adapters/mock.ts` produces
  it (odd-numbered turns). Terminal agents get `waiting_input` on the island through the
  hook's `session.question`, not through the Hub.

---

## Trimming and the lock

Appending is a single `O_APPEND` write and needs no lock. Read-modify-write does.

The Hub carries the same trimmer as the island with a deliberately higher cap, so the two
never fight over the same file:

| | Session Monitor | Chat Hub |
|---|---|---|
| trim above | 2 MB | `MAX_BRIDGE_BYTES` = 8 MB |
| keeps | last 1500 lines | `KEEP_LINES` = 1500 |

In practice the Hub's trimmer only ever fires when the island is not running. The trim is
in place (`open(path,"r+")` → read → `truncate(0)` → `write(tail, 0)`), keeping the inode, so
a hook holding an `O_APPEND` descriptor never loses a line.

The lock is the sibling file `events.jsonl.lock`, taken with `fs.open(path, "wx")` —
`O_CREAT|O_EXCL`, the only primitive Swift, Node and Python all have. Node has no `flock`;
`fs.constants.O_EXLOCK` is `undefined` on the Node builds this app ships against, which is
why a Swift-only `flock` excluded nobody. Constants in `src/main/bridge-lock.ts`:
`WAIT_MS = 1500`, `RETRY_MS = 25`, `STALE_MS = 5000`.

Writers fail open, trimmers fail closed. `tests/bridge-lock.test.ts` pins both halves —
*"fails open rather than blocking the bridge on a live foreign lock"* and *"skips the
destructive trim when the lock could not be taken"* — and `tests/bridge.test.ts` pins
*"trims in place so the Monitor's tail and hook appends survive"*.

**Change all three implementations together or not at all**:
`src/main/bridge-lock.ts`, `SessionMonitor/Services/ChatHubBridge.swift` (`acquireBridgeLock`),
`session-monitor/hooks/agent-desktop-claude-hook.py`.

---

## Reverse channel (Monitor → Hub)

`src/main/command-bridge.ts` tails `commands.jsonl` with `fs.watch` plus a 500 ms poll.

| Line | Effect |
|------|--------|
| `{"type":"session.focus","id":"…"}` | `setActiveSession(id)`, surface the window. An id the manager refuses surfaces the window but pushes `null` to the renderer rather than a ghost session. |
| `{"type":"session.reply","id":"…","text":"…"}` | focus, then `sendMessage`. The `requestId` field is declared in the type and **not read** — the island cannot answer a permission through this channel; it uses the socket. |
| `{"type":"session.new","provider":"…"}` | Creates a session. The island sends no folder, so the cwd is inherited from the most recently updated session — never `process.cwd()`, which is `/` in a packaged app. With nothing to inherit, it only surfaces the window. |

**Cold start matters here.** The island writes the command and *then* launches the Hub, so
starting at EOF would drop the very click that opened the app. The byte offset is persisted
to `commands.jsonl.offset`; the first drain runs in catch-up mode with a
`STALE_COMMAND_MS = 60_000` age filter so an hour-old click cannot spawn anything, and later
drains never age-filter. `tests/command-bridge.test.ts` covers all four cases.

---

## Permission socket

The Hub runs **its own** listener at `hub.sock` (`src/main/permission-socket.ts`) and speaks
the same NDJSON protocol as the island. `SessionManager.permissionEnv()` sets
`AGENT_DESKTOP_SOCKET=<hub.sock>` for spawned CLIs — but only for two providers:

```ts
if (session.provider !== "claude" && session.provider !== "codex") return {}
```

Grok approves in-CLI. For OpenCode the same variable addresses its plugin's event push,
which belongs to the island, not to the Hub.

Every request the Hub accepts is **mirrored byte-for-byte** to the island's `monitor.sock`,
so the same tool call can be answered on either surface. The first answer wins and the loser
is hung up on, and the island's EOF path is what withdraws its card. If the island is not
running, the mirror settles `null` — which means "no answer from that surface", never
"deny". Requests expire after 12 h, are reaped every 5 min, and are all released as `gone`
on `before-quit` so no hook is left holding a decision that can never arrive.

`tests/permission-broker.test.ts` covers the seven cases, including *"mirrors it onto the
island verbatim"*, *"answers from the Hub and hangs up so the island withdraws its card"*
and *"still owns the decision when the island is not running"*.

**Not wired:** the renderer shows a read-only banner (`"Answer in the notch island"`).
`resolvePermission` exists end to end in preload and main and is unused by the UI — see
`docs/roadmap-v2.md`.
