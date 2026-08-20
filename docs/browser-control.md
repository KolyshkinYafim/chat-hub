# Agent-driven browser

**Written:** 2026-08-12, against the code, not a plan.

An agent running under Chat Hub can drive the Browser surface: open a page, read
it as a ref-tagged tree, click, type, screenshot it, read its console and its
network log. It is the same webview the user is looking at, so the human watches
the agent work rather than reading a description of it afterwards.

The mechanism is MCP, because that is the one extension point all four CLIs
share. There is no provider-specific browser code.

```
 claude / codex / grok / opencode
        │  stdio JSON-RPC (MCP)
        ▼
 resources/mcp/browser-mcp.mjs          ← plain Node, zero dependencies
        │  newline-delimited JSON over a unix socket
        ▼
 BrowserSocketServer ──► BrowserService ──► BrowserControl
                              │                   │
              "open the panel"│                   │ Electron WebContents
                              ▼                   ▼
                         renderer            <webview> guest
```

## The pieces

| File | Role |
|---|---|
| `src/shared/browser.ts` | The contract. Ops, result shapes, node/console/network types, `renderSnapshot`, env names, limits |
| `resources/mcp/browser-mcp.mjs` | The MCP server the CLI spawns. Translates 13 browser tools (and the 6 dock tools below) into requests and shapes results back into MCP content blocks |
| `src/main/browser-socket.ts` | The transport. One long-lived connection carries many requests, correlated by `id` |
| `src/main/browser-service.ts` | Opens the surface on demand, then dispatches |
| `src/main/surfaces/browser-control.ts` | The executor. Owns the guest registry, real input events, screenshots, console and network buffers |
| `src/main/surfaces/browser-page-script.ts` | Pure string factory for every script injected into the page |
| `src/main/browser-mcp.ts` | Writes the server into the right per-provider config |
| `BrowserSurface.tsx` | Hands main the guest's WebContents id, shows what the agent just did |

## Tools

`browser_navigate` · `browser_snapshot` · `browser_click` · `browser_type` ·
`browser_fill` · `browser_key` · `browser_scroll` · `browser_hover` ·
`browser_screenshot` · `browser_text` · `browser_console` · `browser_network` ·
`browser_wait`

A **ref** (`ref_1`, `ref_2`, …) is minted only by a snapshot, so an agent cannot
address an element it has not seen, and the next snapshot invalidates the last
set. `browser_click` resolves a ref to a rect in the page, then dispatches real
`mouseMove`/`mouseDown`/`mouseUp` through `sendInputEvent` — trusted input, so
listeners that check `isTrusted` behave as they do for a human.

Password inputs are masked in snapshots.

## The panel opens itself

An agent that has never seen the Browser surface can still say "open
example.com". `BrowserService` notices there is no guest for the session, asks
the renderer to open the panel, and waits up to 4 s for the attach before
dispatching. Only if nothing appears does it answer with a sentence the agent can
act on. This is why `browser_navigate` works from a cold start.

## The rest of the dock

The same server, the same socket and the same session id also carry six tools
that open and read Chat Hub's other panels, under the `surface.*` op namespace. No browser
op contains a dot, so `BrowserService` routes on the op alone and dock calls skip
the guest check entirely.

`surface_open` · `surface_close` · `surface_status` · `surface_run_script` ·
`surface_board_add` · `surface_board_check`

| File | Role |
|---|---|
| `src/shared/surface-control.ts` | Ops, the open request and the renderer's state mirror |
| `src/main/surfaces/surface-control.ts` | Decides what a call may do, pushes it, writes the trace |
| `App.tsx` | Applies the push; reports the dock's visible state back to main |

Three rules hold the design together.

**No call takes the window.** Opening a panel sends one IPC message. It never
calls `show()`, `focus()` or `setSize()` — unlike the browser path, which shows
the window because the guest has to exist before it can be driven.

**A call acts on the session that made it.** The session id comes from
`CHATHUB_BROWSER_SESSION`, the same variable the browser tools use. A call from a
session that is not on screen records the panel choice for that session and stops
there: nothing moves, no file is focused, and `surface_run_script` does not start
the script — a command the user never saw start is worse than no command. Board
writes still land, because those are workspace files, not panels.

**Every open is in the transcript.** `SessionManager.note` writes one system line
into the calling session's thread, so a panel that changed under the user says
who changed it and why. `surface_status` writes nothing; it changes nothing.

Paths go through `resolveContainedPath`, so a dock tool can only name something
inside the session's project. `surface_run_script` runs only scripts already
saved in `.chathub/scripts.json`; there is no way to pass a command through.

## Where the server is registered, per provider

Written at session start, before the CLI spawns — a CLI reads its MCP config at
process start, so a later write is a no-op for that turn.

| Provider | File | Form |
|---|---|---|
| claude | `<project>/.mcp.json` | merged under `mcpServers`, foreign servers untouched |
| codex | `<project>/.codex/config.toml` | `# BEGIN CHATHUB-MCP` marker block |
| grok | `<project>/.grok/config.toml` | same marker block, plus `enabled = true` |
| opencode | `<project>/opencode.json` | merged under `mcp` |

The observed grok shape, from `grok mcp add --scope project`:

```toml
[mcp_servers.probe-server]
command = "/bin/echo"
args = ["hello", "world"]
enabled = true

[mcp_servers.probe-server.env]
FOO = "bar"
```

`grok mcp list` reads back Chat Hub's generated block, including the quoted key
`[mcp_servers."chathub-browser"]` and the marker comments.

The server is spawned as `ELECTRON_RUN_AS_NODE=1 <electron> browser-mcp.mjs`, so
it needs no Node on `PATH`. `electron-builder.yml` ships `resources/mcp` as
`extraResources`, outside the asar, because a spawned process cannot read an asar
path.

## Grok needs the folder trusted

Grok refuses to start repo-local MCP servers in an untrusted folder:

```
✗ folder untrusted (repo-local (project-scoped) server not started for an untrusted folder)
```

Trust lives in `~/.grok/trusted_folders.toml` and there is no `--trust` launch
flag on 1.0.3. Until the folder is trusted, the browser tools simply do not
appear in a grok session — silently, from the agent's point of view.

## Known limits

- Console and network come from the guest. `network` attaches the Chromium
  debugger lazily on first use and answers with a reason rather than throwing
  when something else already holds it.
- The scripts are exercised under jsdom, which has no layout: geometry paths are
  tested against a model, not a real renderer.
- `BrowserActivity` carries no request id, so the renderer shows the last action
  rather than correlating actions with specific calls.
- The MCP config is per project, not per session. Two sessions in one folder
  share the file and the second registration stamps its own session id, so
  `unregisterBrowserMcp` must not run while a sibling session is alive.
