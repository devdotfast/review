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

`pnpm --filter @dev.fast/review test:legacy-corpus` replays a private corpus of
legacy Reviews through migration. Point `REVIEW_LEGACY_CORPUS` at a directory whose
children are Review UUID folders; the script fails if the variable is unset. The
corpus is copied before it is touched and the originals are re-verified afterwards.

The files under `apps/review-desktop/code-oss/` include upstream contribution
and security documents. Those files apply to Microsoft's VS Code project.
This document and [SECURITY.md](SECURITY.md) apply to Review Desktop.
