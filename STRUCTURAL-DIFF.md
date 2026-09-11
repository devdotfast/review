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
within-line change paint. `stats` has textual line counts and either
structural counts or a `fallback` error explaining why tree-sitter did not
run. Lines are 0-based and split on `\n`; columns are byte offsets into the
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
- One fold model serves every region that can hide lines: syntax folds and
  collapsed leaves (context gaps) alike become native folding ranges, seeded
  from the wire's initial visibility, keyed by region id so paired ranges share
  collapse state across sides. Unified view filters folded original lines out
  of its deleted code view zones, and restores them on expansion.
- A collapsed region keeps VS Code's inline `⋯` on its header line. A one-line
  label follows it as injected text; a multi-line label (pseudocode) hangs
  under the header as a view zone in the fold tint.
- Review's native language tokenization and theme color the source rows. Change
  paint uses each leaf's `changed` spans: any line with a span gets the light
  whole-line background, and the spans get the darker token highlight in both
  layouts. Text inequality alone never implies red/green backgrounds.
- Files the manifest marks hidden (generated, tests) start collapsed in the
  multi-diff list with the reason beside the counts; the header click loads them.
- Header and tree counts switch to the stream's textual counts as each file
  lands. The git-based file list is still fetched first: it resolves the
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
