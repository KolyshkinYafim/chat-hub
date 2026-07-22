# Chat Hub — review fix plan

Senior pass over `chat-hub/` (+ bridge consumer in `session-monitor/`).  
Scope: match docs, status honesty, Electron security, adapter readiness.

## MVP vs docs (`docs/mvp.md`)

| Item | Status |
|------|--------|
| Electron + React + TS | Done |
| Sidebar + new session | Done |
| Transcript UI | Done |
| SessionManager + mock | Done |
| Status from events | Done (with gaps below) |
| OS notif waiting_input/done | Done |
| Bridge JSONL | Done (shared path) |
| Persist sessions + messages | Done |
| One real adapter | **Open** (expected) |

Docs/product also want project folder picker, waiting filter, tool UI — out of MVP checklist.

---

## Findings

### P0

1. **`openExternal` unvalidated** — `src/main/index.ts`  
   Any `window.open` URL is passed to the OS (incl. `file:`, custom schemes).  
   **Fix:** allow only `http:` / `https:`.

2. **Renderer sandbox off + no navigation lock** — `src/main/index.ts`  
   Monitor already uses `sandbox: true` + `will-navigate` allowlist. Hub does not.  
   **Fix:** align with Monitor (`sandbox: true`, deny unexpected navigations).

3. **Stuck `running` if adapter throws after status** — `src/main/session-manager.ts`  
   `sendMessage` awaits adapter with no try/finally. Product promise fails when adapter misbehaves.  
   **Fix:** on throw → `error`; if still `running` after send resolves → force `idle`.

4. **Bridge leaves Monitor “running” after Hub death** — cross-app  
   Hub remaps `running→idle` in memory but does not publish correction; Monitor JSONL replay can re-apply last `running`.  
   **Fix:** Hub republish corrected sessions on init; Monitor coerce `running→idle` during cold replay only.

5. **Unknown provider crashes main** — `src/main/adapters/index.ts`  
   IPC can pass arbitrary `provider`; `getAdapter` returns `undefined`.  
   **Fix:** throw on unknown id; validate create payload.

### P1

6. **`before-quit` does not await `flush()`** — possible lost last messages.  
7. **`sendMessage` holds IPC until stream ends** — composer `sending` blocks entire stream; prefer fire-and-stream.  
8. **No cwd picker / validation** — product F1; needed before real CLI spawn.  
9. **Adapter interface ≠ architecture sketch** — callbacks vs `onEvent`/`SessionHandle`; document or converge.  
10. **No process liveness** — no PID/heartbeat; required for real adapters.  
11. **Unbounded JSONL bridge** — growth / privacy; rotate or cap.  
12. **IPC args unvalidated** — sessionId/message types; trust boundary is local UI only today.  
13. **Dual notifications** Hub + Monitor for same event.

### P2

14. No waiting_input filter in sidebar.  
15. Transcript is single JSON blob not JSONL/SQLite (docs preferred).  
16. No secrets/keychain story.  
17. Placeholders only for grok/claude/codex/opencode.  
18. Renderer re-derives status (OK) but can race multi-tab updates.  
19. `session.ended` + `done` semantics fuzzy for multi-turn chat.

---

## Ordered fix list

1. ~~P0 openExternal scheme allowlist~~  
2. ~~P0 sandbox + will-navigate~~  
3. ~~P0 SessionManager send error / stale running~~  
4. ~~P0 Hub init re-publish corrected status to bridge~~  
5. ~~P0 getAdapter unknown provider~~  
6. ~~P0 Monitor replay: running → idle~~  
7. P1 await flush on quit  
8. P1 non-blocking send IPC  
9. P1 cwd picker + realpath allowlist  
10. P1 first real adapter (Grok or OpenCode) with exit → status  
11. P1 bridge rotation  
12. P2 UX filters / persistence format

---

## Real adapters — missing pieces

| Need | Why |
|------|-----|
| Stable `AgentAdapter` + process handle (pid, kill tree) | abort / death → status |
| cwd allowlist + no shell string concat | security |
| stdout/event parse → SessionEvent + chat deltas | UI + Monitor |
| Auth/secrets in main or keychain only | never renderer |
| Per-provider binary discovery + version check | UX errors |
| Crash/exit hooks → never leave `running` | core product |
| Optional: worktree, permissions, subagent child sessions | later |

---

## Implemented this pass

P0 items 1–6 only (safe, local, no large refactor).
