# Native structural diff experiment

This branch replaces the Files view's diff computation with `diffr` when
`REVIEW_DIFFR_BINARY` names an executable. Without it, Review uses its existing
native diff provider. It does not require a diffr server or CodeMirror.

```sh
REVIEW_DESKTOP_DEV_FAST=1 DEV_REVIEW_EXTENSIONS=none pnpm desktop:build
REVIEW_DIFFR_BINARY=/absolute/path/to/diffr \
  DEV_REVIEW_HOME=/tmp/review-structural-home \
  DEV_REVIEW_EXTENSIONS=none pnpm desktop:run
```

Use the same `DEV_REVIEW_HOME` with this checkout's `review` CLI when opening a
Review in this isolated app.

## Implemented

- Review invokes the CLI for its resolved repository comparison and reads v1
  NDJSON from stdout. Nonzero exit, cancellation, incomplete streams and
  per-file errors are surfaced. The executable is host configuration.
- Native Monaco models display the exact source snapshots carried by the wire.
  Base/head comparisons use pinned file URIs so existing language services can
  attach. Revision-only virtual resources retain their existing language-service
  limitations. The sidebar uses ReviewChangedFilesTree (the native Workbench tree).
- Complete `aligned_rows` from the TUI wire drives split alignment when supplied;
  older wire continues to use hunk pairings. Folding hides source rows;
  wrapping and external editor view zones contribute height; only unequal
  segments create alignment spacers. The diff is not recomputed on folding.
- Whole-line fold controls use the supplied fold ranges. Paired ranges share
  collapse state. Unified view filters folded original lines out of its deleted
  code view zones, and restores them on expansion.
- Review's native language tokenization and theme color the source rows. Change paint uses
  the hunks’ `novel_lhs` / `novel_rhs` lists for light whole-line backgrounds and
  `Novel` / `NovelWord` spans for darker token highlights in both layouts. Textual
  replacement groups control layout but never imply red/green backgrounds.
- Unchanged tokens stay neutral regardless of their position or indentation.
- Only `hunks[].lines` are initially visible. Omitted source ranges use native
  expandable context gaps; full models remain intact for language services.
  Structural folds within the visible hunks initially expand. Fold state survives split/unified switches
  while the Files view remains mounted.

## Verified

Both native and server TypeScript checks; six alignment/coordinate tests; four
subprocess protocol tests; native app build. A real two-commit TypeScript fixture
was opened in the isolated app. Mouse checks cover paired collapse/expansion in
both layouts, unequal fold lengths, preserved alignment, unchanged toggle
coordinates, and carrying collapse state between layouts.

## First-pass limits

- Native folding is a whole-line approximation: inline folds and the wire's
  custom placeholder strings are not yet rendered. Native controls retain the
  first source line and show the editor's normal collapsed indicator.
- Fold state is not yet persisted across unmounting the Files view. Defaults
  do not yet specialize by file class or fold tag.
- Older wire without `aligned_rows` uses hunk alignment. Omitted gaps
  are filled positionally for expansion only; use the newer `aligned_rows` wire
  field for authoritative full-file alignment.
- The CLI stream is consumed incrementally, but this first bridge collects a
  comparison before mounting the native view (64 MiB / 120-second limits).
- This is not a large-file performance benchmark or a complete validation of
  comments, nested partial folds, Unicode wrapping, added/deleted files, or jj.

## Larger manual exercise

Review PR #108 was loaded at its original comparison commits:
- Base: `de8ebb1b1fd5786577a68b70c80b0ab8f5bb83b4`
- Head: `f00d6a8b3cbe1b85f1deddbb9a016450003bb8a3`

This covers 30 files, roughly 30,600 aligned rows, and a 32 MB NDJSON payload.
Manual checks covered every file-tree entry, split/unified switching, paired
fold toggles, context expansion, and scrolling between files. Initial visibility
was also checked against the hunk row sets across all 30 files.

The exercise exposed a renderer-reconnect bug: disposing the disconnect emitter
inside its first listener suppressed later cleanup, so old IPC channel servers
kept replaying file-stream chunks after reloads. Cleanup now waits until event
delivery finishes. After three reloads, the sampled file stream delivered one
copy and scrolling crossed file boundaries in both layouts.

Initial mounting still waits for the full subprocess result; this PR does not
claim progressive rendering or a comprehensive performance benchmark.
