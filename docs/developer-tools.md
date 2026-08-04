# Developer tools

Chat Hub exposes a native **Developer** menu in development and packaged builds.

- **Toggle DevTools** (`Cmd+Option+I` on macOS) opens or closes DevTools for the
  Chat Hub renderer.
- **Reload** (`Cmd+R`) reloads the renderer normally.
- **Force Reload** (`Cmd+Shift+R`) reloads while ignoring the renderer cache.
- **Reveal Main Log** shows `main.log` in Finder.
- Right-click inside Chat Hub or an embedded Browser surface and choose
  **Inspect Element** to inspect the exact renderer or guest coordinates.

The main log is intentionally narrow: it records only Developer-menu lifecycle
and action names. It never receives prompts, page URLs, session state, provider
output, tokens or MCP data. The file is mode `0600`, rotates at 512 KiB and keeps
one backup at `main.log.1`.

DevTools and Inspect can display sensitive information already present in the
application or page. They open only after an explicit local user action.

## Packaged smoke test

After `pnpm pack:mac`, launch `release/mac-arm64/Chat Hub.app` (the exact output
folder varies by architecture) and verify all menu actions there. Testing only
with `pnpm dev` is insufficient because the Browser surface and application menu
must also work in the packaged Electron runtime.
