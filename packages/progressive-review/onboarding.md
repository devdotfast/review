# Review workflow

The running Desktop owns the canonical JSON document, retained evidence,
resources, checkpoints and conversations. Author through MCP or `review host`;
never edit a review database, MDX file, TypeScript module or Git note.

1. Use the matching Desktop and CLI. In development, use the checkout-built app.
   Query `capabilities` to check connectivity and allowed operations.
2. Query `repositories.list` and register the requested repository if needed.
   Query `reviews.list` before choosing whether to reuse or create a review.
3. Read optional user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default
   `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md`. Repository
   guidance takes precedence.
4. Call `review.create({repositoryId,change,title,description?})` with the
   requested change selector. Save the returned IDs, versions and exact binding.
5. Open with `review host open --review <uuid>` or MCP `review_open`.
6. Read pinned source through `source.read/file/tree/diff/commits`. Add JSON
   nodes and definitions with small atomic `document.mutate` commands. The host
   validates them and retains source evidence before accepting a new version.
7. Author maps through `map.create/mutate` when useful; retain exact map-version
   IDs. Images and optional trace excerpts likewise enter through resource APIs.
8. Publish explicitly with `review.publish`, using the current document and
   metadata versions and selected base/head map-version IDs (or `null`).
   Inspect the returned checkpoint and any canvas diagnostics.
9. Read submitted `feedback` and `threads`, reply to the specific comments,
   update the document, and publish another checkpoint when requested.

Mutating commands require a caller-chosen UUID command ID. Reuse that ID and
identical input after an uncertain response. For a genuine version conflict,
refetch and reconcile before sending a new command.

Human drafts are private and editable; posted messages are immutable.
**Ask now** launches a fresh trusted local agent with a frozen context, not a
fork of the author. Final answers are saved through the run's completion path.
**Submit review** records selected drafts and a decision without requiring an
agent to be online; it does not automatically resume an author.

Use the bundled [authoring skill](skills/dev-review/SKILL.md) for node shapes,
evidence rules and the full workflow. The trusted bundled tutorial may retain
legacy rendering; old user review data is neither migrated nor deleted.
