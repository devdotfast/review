# Contributing to Whiteboard

Thank you for your interest in Whiteboard.

## Repository layout

- `apps/whiteboard-desktop/` contains the application, packaging scripts, and the
  pinned Code - OSS fork.
- `packages/whiteboard/` contains the Whiteboard command-line interface,
  embedded server, and canvas.
- `packages/whiteboard-protocol/` contains the shared process contracts.
- `packages/local-vcs/` contains local version-control helpers.

See [apps/whiteboard-desktop/UPSTREAM](apps/whiteboard-desktop/UPSTREAM) for the
Code - OSS source revision and fork differences.

## Build and test

See the [README](README.md) for setup and build instructions. Run
`pnpm run ci` before you submit a pull request.

Whiteboard's DOM-facing tests run in Chromium through Vitest Browser Mode. Install
the browser once with
`pnpm --filter @dev.fast/whiteboard exec playwright install chromium`, then use
`pnpm --filter @dev.fast/whiteboard test:browser` for a headless run or
`pnpm --filter @dev.fast/whiteboard test:browser:watch` while developing. Pure Node,
filesystem, and server tests remain available through
`pnpm --filter @dev.fast/whiteboard test:node`.

`pnpm --filter @dev.fast/whiteboard test:legacy-corpus` replays a private corpus of
legacy sessions through migration. Point `WHITEBOARD_LEGACY_CORPUS` at a directory whose
children are Whiteboard UUID folders; the script fails if the variable is unset. The
corpus is copied before it is touched and the originals are re-verified afterwards.

The files under `apps/whiteboard-desktop/code-oss/` include upstream contribution
and security documents. Those files apply to Microsoft's VS Code project.
This document and [SECURITY.md](SECURITY.md) apply to Whiteboard.
