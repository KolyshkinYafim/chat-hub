# Chat Hub changes

## 2026-09-11

- Start a chat from a ClickUp task, Sentry issue, or web link. Review and edit the first prompt before starting. Source badges stay with the session. ClickUp and Sentry require an enabled project MCP connection.
- Focus a source-control diff, navigate files with a position counter, and return with Escape. Operations use the selected repository, including nested repositories.
- Share PR status polling across windows and visible panels, with subscriptions released when panels close.
- Finish the pre-turn checkpoint before starting an agent, preventing snapshots from capturing the agent's own edits.
- Preview a Figma frame in Design or attach it to a prompt when its project MCP key is configured. Refresh or open the PNG, select and fit local artboards, and export local HTML. The composer can prepare an editable Figma asset request.
- Export completed turns to Langfuse using OTLP/HTTP JSON. Tracing is off by default; metadata-only is the default when enabled. Keys require successful OS encryption. Project exclusions, connection testing, bounded batching and retries are included. Tool, reasoning and diff transcript blocks are removed from exported reply text.
- Support Node 26 in DOM tests by binding storage to the actual jsdom window.

External service integrations are checked with local test doubles. Live Figma and Langfuse verification requires configured user credentials. Creating source chats does not automatically post comments or change task status. Board task import and automatic writeback remain future work.
