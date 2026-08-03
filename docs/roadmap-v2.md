# Chat Hub — status and gap map

**Reviewed:** 2026-08-02 against the working tree (uncommitted on `main`).
**Goal:** live in the Hub instead of four separate CLI TUIs.

Legend: ✅ built and covered by a test · 🟢 built, code-level only (no test, not exercised
live) · 🟡 partial · ❌ not built

"Covered by a test" means `tests/` asserts it. `pnpm test` — 16 files, **170 tests, all
passing on 2026-08-02**. `pnpm typecheck` is clean on both projects, and `electron-vite build`
succeeds.

---

## 1. Gap map

### Providers, accounts, models

| Area | Status | Detail |
|------|--------|--------|
| Settings → Providers | 🟢 | Card per provider: auth dot, version, enable switch, binary-path override, model list, API-key fields, Test / Login… / Re-detect |
| Provider enable toggle | ✅ | `tests/settings.test.ts` — *"providers are enabled unless explicitly turned off"*. Disabled providers vanish from every picker |
| API keys | ✅ | Sealed with Electron `safeStorage` as `enc:v1:…`. The renderer receives key **names** only. Nine assertions across the sealing helpers and the store, incl. *"never writes an API key to disk in the clear"*, *"decrypts only for spawn, in main"* |
| Shadow-home instances | ✅ | A second account per provider = `homeDir` → `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` / `OPENCODE_CONFIG`. Six assertions, incl. *"refuses to resolve a removed instance as the default account"* |
| Binary-path override reaches spawn | ✅ | Threaded through `AdapterStartOpts`/`AdapterSendOpts` — was stored-but-ignored before |
| Auth probe | 🟢 | Live `claude auth status --json`, `opencode auth list`, `grok models`. Codex is file-only (`~/.codex/auth.json`) because its `config.json` carries no credentials |
| Model catalog | 🟡 | **Live** for grok (`grok models`, parsed by `parseGrokModels`, covered by two tests) and opencode (`opencode models`). **Curated hardcoded** for claude (`sonnet`/`opus`/`haiku`) and codex (`gpt-5-codex`, `gpt-5`, `o4-mini`, `o3`) — neither CLI has a list command |
| Test connection | 🟢 | Real one-shot call, 30 s timeout, reports latency. Note: it still uses `codex exec --full-auto`, which the real spawn path deliberately avoids as deprecated — an internal inconsistency |
| Codex inside ChatGPT.app | 🟢 | Auto-detected at `/Applications/ChatGPT.app/Contents/Resources/codex` (+ `~/.codex/bin`, `~/.local/bin`) |

### Turns and reliability

| Area | Status | Detail |
|------|--------|--------|
| Argv builders per CLI | ✅ | `src/main/adapters/args.ts` is pure and unit-tested — 17 assertions in `tests/adapter-args.test.ts`, 6 more in `tests/codex-stream.test.ts` |
| Stream parsing | ✅ | 20 assertions in `tests/stream-parse.test.ts` + 5 on snapshot dedupe. Deltas, whitespace collapse, 160-char bridge preview, tool cards, diffs, truncation |
| Message queue while a turn runs | ✅ | 7 assertions: order kept, cancel a queued message, dropped on Stop, dropped on failure with a system line saying so. The queue lives in main and is published to the renderer — the UI keeps no copy |
| Watchdog | ✅ | 15 s tick. `running` with no turn → `idle`, 10 min silent → `abort()` + `error` |
| Shutdown | ✅ | *"stops live turns and persists them as idle, not running"* — the CLIs run detached, so nothing else would signal them when Electron exits |
| Resume | 🟢 | CLI-native id persisted on `SessionMeta.agentSessionId`, adapters re-`start()`ed on boot. Verified against codex by test, not exercised live for grok |
| Per-session permission mode | ✅ | 4 assertions incl. *"clearing the override goes back to following the default, not freezing it"* |
| Cost / tokens | ✅ | Per-turn chip + session total, persisted across restart. 7 assertions in `tests/usage.test.ts`, 3 in the manager |
| Concurrent sessions | 🟢 | One turn per session, N sessions in parallel. Not stress-tested |
| Transcript size | 🟡 | Hard cap `MAX_MESSAGES_PER_SESSION = 200`, enforced in `appendMessage()` only. No archive, no lazy load. A longer restored transcript is trimmed on the next message |

### UI

| Area | Status | Detail |
|------|--------|--------|
| Sidebar: projects, filters, archive | 🟢 | Pinned projects persist without sessions. Filters are `All` / `Work` / `Wait` only |
| Transcript search | ✅ | Searches message bodies, not just titles. 8 assertions in `tests/transcript-search.test.ts`. Clicking a hit scrolls to the message and flashes it |
| ⌘K session switcher | ✅ | Fuzzy ranking covered by 6 assertions in `tests/fuzzy.test.ts` |
| Keyboard map | 🟢 | `⌘K` switcher · `⌘N` new · `⌘,` settings · `⌘/` shortcut list · `⌘G` source control · `Esc` stop the running turn. `ShortcutsOverlay` lists them. Not user-remappable |
| Tool cards + diffs | ✅ | Hand-rolled markdown: ` ```tool:Name `, ` ```tool-result:Name `, ` ```diff ` with +/− counts. A diff or result following a call folds into that card. 3 assertions in `tests/renderer-state.test.ts` |
| Source Control panel | 🟡 | **Real logic, no CSS.** Stage / unstage / per-file diff / branch switch / commit-staged are all wired to `src/main/git.ts`. `styles.css` contains zero `.scm*` selectors, and `<aside className="scm">` is the third child of a 2-column grid — so ⌘G currently renders an unstyled block below the sidebar |
| Permission approve/deny in-app | ❌ | The banner says `"Answer in the notch island"`. `resolvePermission` is exposed in preload, handled in main, and `App.resolvePermission` is written — it is simply never passed to `ChatView`. The stale comment in `ChatView.tsx` claiming main has not exposed it is wrong |
| First-run wizard | 🟢 | 3 steps (detect → connect + default model → open folder), gated on `general.onboarded` + zero sessions. Preview with `?mock=1&wizard=1` |
| `waiting_input` in the sidebar | ❌ | The "Wait" filter is dead for real providers — only `adapters/mock.ts` ever emits that status |
| Worktrees | ❌ | |
| Session archive | 🟡 | Renderer-only, `localStorage["chat-hub.archivedSessions"]`. `SessionMeta` has no `archived` field, so it does not survive a different machine or a wipe |

### Packaging and integration

| Area | Status | Detail |
|------|--------|--------|
| `.app` build | 🟢 | `pnpm pack:mac` → `release/mac-arm64/Chat Hub.app`, identity stamped into `Info.plist` (`AgentDesktopBuildCommit`) and `out/build-info.json` |
| Signing | ❌ | `electron-builder.yml` sets `identity: null`. The packaged app **fails `codesign --verify`** (*"code has no resources but signature indicates they must be present"*, verified 2026-08-02) and macOS will call it damaged after a zip or AirDrop |
| Install to `/Applications` | 🟡 | `pnpm install:mac` exists, but nothing is installed on this machine right now, and the app in `release/` is a stale 22 Jul build with no identity stamp |
| Bridge to Session Monitor | ✅ | See [bridge.md](./bridge.md). 15 assertions across `tests/bridge.test.ts` (3), `bridge-lock.test.ts` (6) and `command-bridge.test.ts` (6) |
| Unified permission socket | ✅ | Hub listener + verbatim mirror to the island, first answer wins. 7 assertions in `tests/permission-broker.test.ts` |
| Jump Monitor → Hub session | 🟢 | `session.focus` / `session.new` consumed with a cold-start offset and a 60 s staleness filter. Covered by tests. The end-to-end click has not been re-run since the socket landed |

---

## 2. How each CLI is actually invoked

`src/main/adapters/args.ts`. These flags are the thing that silently breaks between CLI
versions, which is why the builders are pure functions with their own test file.

```
claude   -p <prompt> --output-format stream-json --verbose --include-partial-messages
         [--permission-mode …] [--dangerously-skip-permissions] [--model M] [--effort L] [--resume ID]

grok     --single <prompt> --output-format streaming-json --cwd <cwd>
         [--permission-mode …] [--always-approve] [--model M] [--resume ID]

opencode run <prompt> --format json --dir <cwd> [--model M] [--file P …] [--session ID] [--auto]

codex    exec <prompt> --cd <cwd> --json --skip-git-repo-check [--model M]
         [--dangerously-bypass-approvals-and-sandbox | --sandbox workspace-write|read-only]
codex    exec resume <threadId> <prompt> --json --skip-git-repo-check [--model M]
         [--dangerously-bypass-approvals-and-sandbox]
```

### Attachments no longer use `--file`

Earlier versions of this document said the composer passed attachments with `--file`. That
is wrong for three of the four CLIs and would silently drop the files.

`promptWithAttachments()` folds the picked absolute paths into the prompt text as
`@/abs/path` mentions for **claude, grok and codex**. Claude's `--file` wants
`file_id:relative_path` uploads and drops anything without a colon. **Only opencode** keeps a
real flag, because its own `-f/--file` does take local paths.

Four assertions guard this, including *"never passes --file: Claude 2.x wants
file_id:relative_path uploads"* and *"keeps --file: opencode's own flag does take local
paths"*.

### Codex flags, verified against the binary

Checked 2026-08-02 against `/Applications/ChatGPT.app/Contents/Resources/codex`,
**codex-cli 0.146.0-alpha.9.2**:

- `exec --json` prints clean JSONL on stdout with log lines on stderr. Without it the
  transcript gets the human TUI rendering.
- `exec resume <thread_id>` really does keep conversation history.
- `exec resume` **rejects** `-C/--cd`, `--sandbox` and `--add-dir` (*"unexpected argument
  '-C'"*), so a resumed turn takes its working directory from the spawn cwd and a resumed
  non-YOLO turn keeps the CLI default sandbox.
- `--full-auto` is deprecated and only means `--sandbox workspace-write`, so real YOLO
  needs `--dangerously-bypass-approvals-and-sandbox`.

Item types are parsed from `item.completed` only (`item.started` would double every line);
`reasoning` items are deliberately dropped from the transcript. `tests/codex-stream.test.ts`
ends with a full recorded turn: *"yields the thread id, both messages, one tool card and the
usage"*.

### Grok is unverified

Grok is installed at `~/.grok/bin/grok` but **not signed in** — `grok --single …` answers
`{"type":"error","message":"Not signed in…"}`. Its stream event shape could not be checked
against a real turn. The parser is deliberately liberal (delta from `ev.delta`, `ev.text` on
any type containing `delta`/`stream`, snapshots from `assistant|message|response|result`),
and the snapshot-dedupe fix applied to it is **defensive and unverified against live grok
output**. Treat any grok transcript weirdness as an open question, not a regression.

---

## 3. Next

Ranked by how much they hurt daily use.

1. **Style the Source Control panel.** The logic is done and unreachable in practice.
2. **Wire in-app Allow/Deny.** Everything but the prop-passing exists. Today an approval
   forces you to the island.
3. **Sign the packaged app** (`electron-builder.yml` → a real identity, or at least an
   ad-hoc `codesign --force --deep --sign -` step like `session-monitor/packaging/install-app.sh`
   already does).
4. **Transcript archive / lazy load** past the 200-message cap.
5. **Decide what `waiting_input` means for real providers**, or drop the "Wait" filter.
6. **Live-verify a grok turn** once the CLI is signed in, and record a fixture.

Out of scope, unchanged: own LLM backend instead of CLIs, cloud multiplayer, parity with
every CLI flag, rebuilding the Session Monitor island inside the Hub.

---

## 4. Known internal inconsistencies

Found while reading. None of them break a test, and all of them will confuse the next reader.

- `testProvider` uses `codex exec --full-auto`; `buildCodexArgs` documents that flag as
  deprecated and avoids it.
- The composer permission chip's tooltip says *"applies to every session"* but
  `App.changePermission` calls the **per-session** `setSessionPermission`. The New Session
  dialog's "Permissions (all sessions)" really is global.
- `TopBar`'s Commit button is titled `git add -A && git commit`; it opens the Source Control
  panel, which explicitly never runs `add -A`.
- `permission-socket.ts` justifies unlinking a stale socket with "a second Hub instance is
  already prevented by Electron's lock" — **there is no `requestSingleInstanceLock()` call
  anywhere in `src/`**. A second launch would unlink the first instance's socket.
- The sidebar's Archived group ignores both the search query and the status filter.
- `docs/architecture.md` still describes a `SessionHandle` / `onEvent` adapter interface that
  does not exist, and SQLite persistence that was never built (it is `state.json`).
