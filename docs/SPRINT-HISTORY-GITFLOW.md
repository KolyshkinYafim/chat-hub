# History and Git-flow sprint

This sprint keeps the renderer fast while making long-running, parallel agent
work recoverable and reviewable.

## Implemented

- `state.json` keeps only the newest 200 messages per session.
- Complete transcripts live in `data/transcripts/<session-id>.json` and are
  migrated from legacy `state.json` tails on first boot.
- The renderer requests older pages when the transcript reaches the top, and
  restores scroll position after prepending them.
- New sessions can opt into an isolated `~/.chathub/worktrees/<project>/…`
  directory and a `chathub/<slug>-<id>` branch. The default stays off for
  non-Git folders; enabling it starts from the current `HEAD`.
- Session deletion removes a clean isolated worktree; a dirty worktree is
  preserved and reported in the main-process log instead of being discarded.
- Source Control exposes explicit `Push` and `Create PR` actions. Push uses
  `git push --set-upstream origin HEAD`; PR creation uses `gh pr create` with
  argument arrays, never shell interpolation.

## Verification

- Full Vitest suite: 383 passed, 4 live-only tests skipped.
- Node and web TypeScript checks pass.
- Production Electron build passes.
- Dedicated tests cover transcript migration/tail paging, path traversal
  rejection, and creation/removal of an isolated Git worktree.

## Deliberate follow-ups

- A review gate before Push/PR (currently the existing diff pane is the review
  surface, and actions remain explicit buttons).
- PR title/body generation from the transcript.
- Worktree cleanup UI for sessions whose dirty worktree was preserved.
