# Native structural diff experiment

Enable **Settings → Experimental Features → Structural Diffs** to replace the
standard Diff view with the structural viewer. The setting is saved as
`review.experimental.structuralDiff.enabled`, defaults to off, and remounts open
review views when changed. Turning it off restores the standard provider without
requesting structural diffs.

The Review host runs `diffr` from PATH, or the executable named by
`REVIEW_DIFFR_BINARY`. The environment variable selects the executable; it does not
enable the feature. Missing or incompatible executables surface an error in the
Diff view. A diffr server and CodeMirror are not required.

```sh
REVIEW_DESKTOP_DEV_FAST=1 DEV_REVIEW_EXTENSIONS=none pnpm desktop:build
REVIEW_DIFFR_BINARY=/absolute/path/to/diffr \
  DEV_REVIEW_HOME=/tmp/review-structural-home \
  DEV_REVIEW_EXTENSIONS=none pnpm desktop:run
```

Use the same `DEV_REVIEW_HOME` with this checkout's `review` CLI when opening a
Review in this isolated app.

## The wire

Review reads diffr's v2 NDJSON stream: a `start` header carrying the file
manifest, one `file` record per changed file in completion order, and a
`complete` footer. Every record is internally tagged with `type`; optional
fields are omitted rather than null. A pairing of sides serializes by
presence: `{lhs, rhs}`, `{lhs}` for a deletion, `{rhs}` for an addition.

A text diff carries each side's full `text` and a tree of `regions`. Leaves
tile the file in order; a region with children is a fold whose range is the
hull of its children. The same region `id` on both sides marks a pair, so
pairing needs no cross-references. Every region has a `visibility` with
`collapsed` and a `label`; a collapsed leaf is a context gap, a collapsed fold
is a folded body, and the label is what shows while collapsed (a placeholder,
or the pseudocode a summarizer wrote). Leaves carry `changed` byte spans for
within-line change paint. `stats` has `textual` line counts, `visible` counts under the
initial fold state, and a `fallback` error when the AST match did not run. Lines are 0-based and split on `\n`; columns are byte offsets into the
wire text; ranges are half-open.

The reader is `common/reviewStructuralDiff.ts`; the host side is
`packages/progressive-review/src/server/structural-diff.ts`.

## Implemented

- The host invokes the CLI for Review's resolved comparison and forwards the
  stream. Nonzero exit, cancellation, incomplete streams, per-file errors and
  a `complete` that carries `aborted` are surfaced. The executable is host
  configuration.
- Native Monaco models display the exact source snapshots carried by the wire.
  Base/head comparisons use pinned file URIs so existing language services can
  attach. Revision-only virtual resources retain their existing language-service
  limitations. The sidebar uses ReviewChangedFilesTree (the native Workbench tree).
- Split alignment is the zip of both sides' leaves by id: paired leaves pair
  line for line, unpaired leaves pad the other side, and a paired leaf whose
  partner already went by is a move, shown one-sided for now. Folding hides
  source rows; wrapping and external editor view zones contribute height; only
  unequal segments create alignment spacers. The diff is not recomputed on folding.
- Every region the wire marks collapsed is a diff-editor hidden-region band,
  the same full-width `⌃ … ⌄` control the diff editor draws for unchanged
  code, supplied to the diff model as labelled context gaps instead of
  computed by Monaco. A fold keeps its first line (the signature) visible and
  hides the rest; a leaf hides every line. Regions collapsed under one id on
  both sides are one band; a region collapsed on one side only is a band there
  and an alignment spacer on the other. Native folding is off in the
  structural editor, so bands are the only thing hiding lines.
- The band's title is the region's label ("142 unchanged lines", "test
  module", "5 test bodies", "59 lines removed"). A multi-line label, the
  pseudocode summary, opens the band to show the whole text under its first
  line in monospace. Revealing a band with its arrows or by double-click marks
  the region open on both sides and the visible counts follow.
- Review's native language tokenization and theme color the source rows. Change
  paint uses each leaf's `changed` spans: any line with a span gets the light
  whole-line background, and the spans get the darker token highlight in both
  layouts. Text inequality alone never implies red/green backgrounds.
- Files the manifest marks hidden (generated, tests) start collapsed in the
  multi-diff list with the reason beside the counts; the header click loads them.
- Header and tree counts are visible changed lines: the wire's `visible` on
  arrival, recomputed locally as folds toggle. The file tree pane sums them
  into a review total with GitHub's five-block bar; hovering a count shows
  `visible`, `textual`, and `line diff: <code>` when the file fell back. The git-based file list is still fetched first: it resolves the
  pinned checkout resources the editors open before any diff arrives.
- Settings → Experimental Features shows diffr's own configuration when
  structural diffs are on. The host runs `diffr config schema` and `diffr config
  show --json`, the page renders one row per key with its description and
  default, and each change runs `diffr config set <key> <value>`. It is the same
  file the diffr terminal UI edits.

## Verified

Both native and server TypeScript checks; alignment, folding-model and paint
tests against hand-written v2 fixtures; subprocess protocol tests including an
aborted run; diffr configuration reads and writes against a stand-in CLI.

## Limits

- Monaco keeps one folding range per start line and needs ranges to nest, so
  a fold that begins on its parent's header line yields to the parent, a
  collapsed gap folds under the nearest free line above it. The wire
  guarantees a strict tree, so a range set that fails to nest is a wire bug
  and fails that file rather than silently disabling folding.

- Native folding is a whole-line approximation: inline folds are not rendered.
- Fold state is not yet persisted across unmounting the Files view.
- Moves render one-sided; the wire expresses them, the view does not link them yet.
- Comparisons retain the 64 MiB / 120-second limits and are not yet cached.
- The stream is forwarded as NDJSON. The file tree appears before diffs arrive,
  with loading indicators and per-file errors. Ready files are inserted in tree
  order without replacing the existing editors; selecting a pending file reveals
  it when ready. Disposing the review cancels the subprocess.
- This is not a large-file performance benchmark or a complete validation of
  comments, nested partial folds, Unicode wrapping, or jj.
