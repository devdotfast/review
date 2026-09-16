# Deliberately retained UI behavior

The post-comments UI cleanup leaves these candidates in place:

- Document rendering uses `createElement` because tag and component identity come from document data. The remaining cosmetic call sites in `agent-markdown.tsx` and `review-view-state.ts` can change when those files next need editing.
- The Diff tab opens an editor; the Files and commit-scoped Files views already share one implementation.
- Per-editor bridge handles own height, error, find, and disposal behavior. A canvas-wide mount API would need to preserve these lifetimes.
- Separate review state and action contexts isolate open peeks from unrelated updates.
- The React height estimator sizes placeholders before a workbench editor exists; the workbench estimator operates during the editor lifecycle. Sharing them is outside this cleanup's scope. The protocol generator can carry functions, as the shared exact-range diff counter demonstrates. Keep their minimum-one-line clamp aligned if either estimator changes.
- Scroll restoration observes all descendants with `ResizeObserver`; narrowing its coverage needs a reproduced problem.
- Read-only peek editors retain `domReadOnly: false` pending an accessibility check.
- Reloaded diff content duplication was reported before this cleanup. The suspected unified-diff remainder/line-mapping and cached-patch interaction needs separate instrumentation; this cleanup does not diagnose or fix it.
- The README hero and four redesign PNGs remain out of scope. The hero still needs a separate capture reflecting the removed Ask/Threads UI.

Runtime code-peek resolution and its success/failure telemetry are removed. Source validation remains part of publication. Native editors still report unavailable sources locally, and native headers retain exact authored-range counts, including original grouped selections before display-range merging.

## E: canonical source ranges

- `AnchorRef.peek` is the canonical `Source` (`{ side, file, fromLine, toLine }`)
  from `packages/review/src/source.ts`. The authoring *input* (`peek: { file,
  fromLine, toLine, graph?, theme? }`) is unchanged; `graph` maps to `side`
  (default `head`) and `theme` is accepted but no longer carried.
- Sealed bundles written before this change store
  `{ __kind: "code-peek-ref", props, resolution: null }`. The server upgrades
  them when it reads the bundle (`readReviewDocumentBundle`); files on disk
  are not rewritten.
- `ReviewDefinitionEnvironment.resolveCodePeek` became `validateCodePeek`,
  returning `void`; `CodePeekResolutionContext` is `CodePeekValidationContext`.
- Path, bounds and blank-range checks are shared by legacy publish and JSON
  accept (`source.ts`). Legacy still reads the pinned worktree; JSON reads the
  blob at the pinned commit. Whitespace-only ranges are rejected wherever the
  range renders as a peek (code peeks, steps, frames, lens operations); prose
  links only need the range to exist.
- The peek side panel content is `{ kind: "source", source }`; `CodePeekCard`
  and `CodePeekGroup` take `Source` values. JSON `code_peek` blocks render
  directly, with no source-text fetch during document load.
- No command runs an off-screen render: every block kind's schema and check
  in `review-api/blocks/` run in the store before a write.

## F: canonical call-stack frames

- `CallStackDiff` documents store frames (`{ id, key?, source, label?, via? }`
  from `review-api/document.ts`) on both sides. Legacy anchor lists and
  `calls()` hops convert once on the server: at publish in materialize, and
  for sealed bundles in the read-time upgrade walker. The anchor id becomes
  both `id` and matching `key`, so shared frames still align by anchor.
- Matching identity is `key`, else the source range; React and selection
  identity stay on `id`. A `calls()` hop becomes the child frame with
  `via: { kind: "call", reason }` (`"asserted"` when no reason was given).
- The renderer no longer parses the authoring schema per render; the base/head
  side rules remain a publish-time check in the authoring schema and a JSON
  ingestion check in `checkReferences`.
- The authoring registry type still describes authored MDX props; the app's
  runtime registry satisfies it for every component except `CallStackDiff`
  until Part I moves the registry to document props.

## G: canonical sequence steps

- `SequenceDiagram` documents store the canonical block props
  (`{ id, title, actors: Record<name,label>, steps }`). Legacy messages convert
  once on the server (`sequence-steps.ts`): at publish in materialize and for
  sealed bundles in the read-time upgrade walker. Ids follow the old runtime's
  rules (`sequence-<slug>` for the diagram; the anchor id, `--sequence-use-N`
  for repeats, and `sequence-<slug>-message-N` for code-only messages for
  steps), so persisted tour state and deep links still resolve.
- A message with both an anchor and code becomes a `code` step (tour content
  precedence was already code first). Actor `softwareMapPath` values are not
  carried; the diagram never rendered them.
- The renderer derives participants and edges with pure functions over step
  actor names (`sequenceView`); `createSequence`, `SequenceRef`, actor
  normalization and placeholder anchors are gone. Tour stops and edge handles
  key on the step id.
- The authoring input (`<SequenceDiagram label messages>` with anchors or
  inline actors) is unchanged and still validated by the authoring schema at
  publish.

## H: canonical database lens blocks

- `DatabaseLens` documents store one canonical block (`{ id, title?, height?,
  actors, stores, useCases }`). A legacy lens and its `DbUseCase` / `DbRead` /
  `DbWrite` child nodes lower into that block once on the server
  (`database-lens-block.ts`): at publish in materialize and for sealed bundles
  in the read-time upgrade walker. The marker nodes do not survive into the
  document; `reviewComponentDataSchemas` and the app registry no longer list
  them (`ReviewDocumentComponentName` is the document's component set, while
  `ReviewAuthoringComponentName` still types authored MDX).
- Ids are kept: the lens id is `db:<slug(title)>`, use cases keep their authored
  id, and an operation's id is its anchor id, so tour state and deep links
  still resolve.
- The canonical `database_lens` block gained optional, backwards-compatible
  fields for everything the lens renders: actor `softwareMapPath`, store
  `dataStoreKind` and `softwareMapPath`, collection `key`, field `example` and
  nested `fields`, and operation `detail`. Nested document fields are addressed
  by dotted `field` paths; `checkReferences` walks them.
- The renderer resolves operations to plain actors and store targets
  (`lensUseCases`, `lensTarget`) and builds its C4 snapshot from the block; the
  React-child walk, the symbol-backed collection handles, `resolveTargetRef`
  and the `"type?"` string round trip are gone from the render path. A field's
  nullability still displays as the `type?` suffix.

## I: one document input

- The app registry satisfies `ReviewDocumentComponentRegistry`, typed by the
  document props each sealed node carries; the authoring registry type still
  describes authored MDX only. Prose (`AnchorLink`, `ReviewSection`), trace
  quotes and tutorial components take document props and no longer parse
  authoring schemas per render.
- The side panel and guided tours key on their own `PeekAnchor` contract
  (`{ id, title, detail?, peek?, softwareMapPath? }`); diagrams build one from
  their document props. `codePeekSource` lives in `source.ts`.
- Hydration no longer canonicalizes anchor refs to shared objects (nothing in
  the app relied on identity, and every component reads anchor values). It
  keeps heading ids, section summaries, tutorial text hints and software-map
  hydration. A saved document whose component anchors are absent from the
  top-level `anchors` map now renders instead of failing to load.
- Trace-quote containment is shared by legacy publish and JSON accept
  (`evidence.ts`): both compare whitespace-normalized text. Software-map pin
  checks stay per path because only JSON reviews carry pins in the document.
- `git grep 'src/authoring"' packages/review/app/src` (non-test) now lists only
  the test utility that builds a legacy definition session.

## Heading ownership

- `ReviewSection` renders its own `<h2>` from `title`; hydration drops the
  heading child that published bundles carry.
- Heading ids are assigned once, in the projection pass, to `h2`/`h3`
  elements and to sections; the Contents rail reads the same ids. They are
  DOM-only. Sequence and lens ids share the slug rule and are unchanged.
- `data-review-block-tag` is no longer stamped; materialization drops it and
  hydration strips it from older bundles.
