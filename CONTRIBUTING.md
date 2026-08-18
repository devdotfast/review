# Contributing to Review Desktop

Thank you for your interest in Review Desktop.

## Repository layout

- `apps/review-desktop/` contains the application, packaging scripts, and the
  pinned Code - OSS fork.
- `packages/progressive-review/` contains the Review command-line interface,
  embedded server, and canvas.
- `packages/review-protocol/` contains the shared process contracts.
- `packages/local-vcs/` contains local version-control helpers.

See [apps/review-desktop/UPSTREAM](apps/review-desktop/UPSTREAM) for the
Code - OSS source revision and fork differences.

## Build and test

See the [README](README.md) for setup and build instructions. Run
`pnpm run ci` before you submit a pull request.

The files under `apps/review-desktop/code-oss/` include upstream contribution
and security documents. Those files apply to Microsoft's VS Code project.
This document and [SECURITY.md](SECURITY.md) apply to Review Desktop.
