# Review as data

Date: 2026-09-04
Status: approved in discussion; current-presentation recovery scope clarified 2026-09-04
Worktree: `../review-data-format` (branch `review-data-format`, off `origin/main` 0ad9297b)

## Goal

A published Review is a JSON document that the canvas app renders. No
agent-authored code reaches the app. Authoring stays `review.mdx` + `data.ts`
for now; a plain-JSON authoring format is a separate, later change.

## Decisions (revised 2026-09-04 after the Codex design review)

The change is phased. Phase 1 and 2 remove executable code from the
storage, serving, and browser boundary while keeping the proven authoring
compiler. Phase 3 removes the compiler and esbuild, and is planned separately.

The recovery clarification below supersedes the earlier republish instructions:
migrate or repair only the **currently presented document and its independently
presented map**, including accepted/rejected reviews. Do not convert or repair
every revision in private history. The implementation plan adds B8a and B8b
between B8 and B9; completed A1–B7 work is not restarted.

| # | Decision | Rationale |
|---|---|---|
| D1 | Change the published artifact only. Authoring format unchanged. | Lands the renderer and schema first; a later authoring change becomes a parser swap. |
| D2 | No dual loader in the app. `review migrate apply` converts the current presentation's exact sealed bundles, including terminal reviews, without recompiling authored sources. Failed conversions leave the stored review unchanged but remain openable through a read-only legacy adapter and an explicit `review repair --review <uuid>` recovery action. | Automatic migration and explicit source repair are different operations. Only current presentation pointers can change; older private revisions remain immutable and are not repaired. Compatibility evaluation runs in CLI tooling, never the server or app. |
| D3 | Phase 2 produces the JSON from the existing pipeline: MDX → JSX → esbuild bundle → publish validation runtime → one `materializeReviewDocument()` traversal over the element records the stub `jsx` already builds → `JSON.stringify` → `JSON.parse` → schema parse → sealed artifact. | The runtime already invokes the document and walks every element (`review-publish-element-audit.ts`). Retaining that tree is one traversal; replacing the compiler is a second migration and is deferred to Phase 3. |
| D4 | Phase 3 (separate plan) replaces the compiler with a markdown-AST builder plus a native Node import of `data.ts` through a `module.registerHooks` resolve hook, as proven by the spike. | Node 24 is pinned everywhere. Deferred so Phase 2 carries no new authoring restrictions, no `new Function`, no hook or cache-busting concerns. |
| D5 | Materialized props are "zod-parse, then normalize to the component's data shape". Most parsed props are already JSON. Known exceptions: `DatabaseLens.stores` (symbol-backed store handles → explicit `{ target, schema }` collection data, rebuilt into handles on load) and software models (`elementsByPath` omitted, rebuilt on load). | `databaseLensPropsSchema.stores` is a `z.custom` that keeps handle identity; symbols never enter JSON. The earlier claim that zod decodes all handles was wrong; it decodes only `DbRead.from` / `DbWrite.to`. |
| D6 | The boundary is enforced mechanically at publish: `reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(materialized)))`. The schema is built from `JsonValue`, never `unknown`. | Anything non-JSON fails publish, not the app. |
| D7 | Prose is an owned node schema, not arbitrary hast: an allowlist of Markdown/GFM tags, an allowlist of props (`className`, `href`, `title`, `id`, `align`, `checked`, `disabled`, `data-review-*`), and an allowlist of `href` protocols. Props keep the React names the MDX compiler already emits. | Normalization runs after the compiler, so `data-review-block-index` and `className` arrive with their final names; no property-name conversion. |
| D8 | The software map becomes data in Phase 1: the per-review bundle writes the model's `elements` and `relationships` as JSON instead of wrapping them in a JS module. Git notes and the tolerant materializer are untouched. | The generated map module already `JSON.stringify`s both arrays and only rebuilds `elementsByPath`. |
| D9 | Publish validates every code peek against the pinned worktree and strips resolutions from the JSON. On load the app resolves every unique peek once, before mounting the document, and caches by document content hash. Components stay synchronous. | Six app modules read `peek.resolution` synchronously; the pre-mount pass replaces the eager resolution the browser session performed at module import. |
| D10 | `ReviewCanvasContent` stays `kind: "session"`. Its `document` and `softwareMap` promises resolve to independent load states: `ready`, `needs-republish`, `unavailable`. | A stale document must not hide Diff, Commits, Threads, or a valid map. |
| D11 | UI state that keys off document identity uses the artifact content hash (`detailRevision`, the document boundary key), not object identity. | JSON objects are recreated on every load. |
| D12 | Migration bumps the store schema to 5. The migration warning remains until all supported records migrate or are explicitly repaired; a failed supported record also has an Open recovery action. Repair preserves lifecycle status, pins, threads, and dismissal state. | Reuses migration machinery with per-review rollback. Recovery is a narrow artifact-replacement operation, not an ordinary publication or a reopening of terminal reviews. |

## 1. Current state

- `review publish` compiles `review.mdx` with `@mdx-js/mdx`, transpiles with
  TypeScript, type-checks a virtual TSX program, bundles with esbuild, then
  re-executes the bundle under Node with a stub React to audit props
  (`src/compiler/`, `src/server/doc-bundler.ts`, `src/review-publish-evaluate.ts`).
- The sealed artifact is `.bundle/document/review-document.js`. The desktop
  server serves it as JavaScript. The code-oss host fetches it, string-replaces
  the `"review-doc-runtime"` specifier with the URL of the canvas's React
  re-export chunk, wraps it in a Blob, and `import()`s it
  (`apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewDocumentModule.ts`).
- The software map is the same pattern: `software-map.ts` from git notes is
  bundled by the server at session time and blob-imported; `defineSoftwareMap`
  normalizes it in the browser.
- The canvas reads four things from the loaded module: the React component,
  the anchors table, anchor contents, and the software models
  (`app/src/review-documents-runtime.ts`).
- Authored content is already declarative: prose, headings, and component tags
  whose props reference `data.ts` exports. The tutorial has zero logic.

## 2. Data format

One JSON file per sealed revision: `.bundle/document/review-document.json`.
Its zod schema lives in `packages/progressive-review/src/review-document-data.ts`
and is shared by the producer and canvas. `review-protocol` owns the transport
load-state contract; it does not import the authoring package.

```ts
interface ReviewDocumentData {
  format: "review-document/1";
  title: string;
  routePath: string;
  sourcePath: string;                       // "review.mdx"
  body: ReviewNode[];                       // rendered document
  anchors: Record<string, AnchorRef>;       // by anchor id
  anchorContents: Record<string, string>;   // authored code text per anchor id
  softwareModels: SoftwareModelData[];      // defineSoftwareModel exports
}

type ReviewNode = ReviewElementNode | ReviewTextNode | ReviewComponentNode;

interface ReviewComponentNode {
  type: "component";
  name: ReviewAuthoringComponentName;       // one of the registry names
  props: Record<string, JsonValue>;         // zod-parsed, JSON only
  children: ReviewNode[];
}
```

- **Prose** is hast, the HTML-ish AST `remark-rehype` emits: `h2`, `p`,
  `strong`, `code`, `table`, and so on. The existing `rehype-review-targets`
  plugin still stamps `data-review-block-index` and table-cell attributes, so
  thread anchoring on prose is unchanged.
- **Components** are a distinct node type, not a hast element with a
  capitalized tag, so no hast tooling ever treats nested prop objects as HTML
  attributes. `name` is validated against the registry; `props` is what the
  component's schema in `src/authoring.ts` returned from `parse`, with
  `children` removed. Anchor, actor, and target refs are inlined as their
  `db-anchor-ref`, `db-actor-ref`, and `db-target-ref` values, which carry
  stable ids.
- **Sections and anchor links** are components, because the existing
  `remark-review-sections` and `remark-review-anchor-links` plugins already
  rewrite `##` headings to `ReviewSection` and links such as `[label]`
  targeting `anchors.key` to `AnchorLink`.
- **Lowercase JSX tags** in prose (`<b>`, `<br />`) are HTML in MDX and become
  hast elements. Only capitalized names are components.
- `anchorContents` moves from the browser (`collectReviewAnchors`) to publish.
  Same derivation, same duplicate-content error.
- Phase 2 validates and materializes the evaluated props; it adds no syntax
  restriction on expressions or attributes. A value that cannot pass the
  component and JSON schemas fails publication. The explicit JSX-attribute
  syntax restriction belongs to Phase 3.

## 3. Publish pipeline (Phase 3 design; Phase 2 keeps the compiler and adds materialization, see the plan)

Replaces the compile, transpile, typecheck, and bundle stages inside
`review publish` and every other caller of `evaluateReviewDocumentBundleForPublish`
(`review-scaffold.ts`, `review-publication-preparation.ts`).

1. **Parse** `review.mdx` to mdast with the existing options: frontmatter,
   GFM, `remark-review-anchor-links`, `remark-review-sections`. Component
   tags arrive as `mdxJsxFlowElement` / `mdxJsxTextElement`.
2. **Read the import line.** The single `mdxjsEsm` node must be one
   `import { ... } from "./data.ts"`. Its specifiers define the local names
   expressions may use, honoring renames. Any other ESM (a second import, an
   `export`) is a publish error. Bare `{expr}` blocks in prose
   (`mdxFlowExpression`, `mdxTextExpression`) are a publish error.
3. **Evaluate `data.ts` once.**
   - Create the Node `createReviewDefinitionSession` with the same
     environment publish uses today (materialized software map, pinned
     worktree code-peek resolver).
   - Register a sync resolve hook (`module.registerHooks`) that maps
     `virtual:progressive-review-authoring` to a shim module exporting the
     session's `defineActors`, `defineAnchors`, `defineStores`,
     `defineSoftwareActors`, `defineSoftwareStores`, plus `calls` and
     `defineSoftwareModel`, and that appends `?v=<publish id>` to every
     resolved URL under the review directory. The directory prefix is
     realpathed first, because Node realpaths resolved file URLs.
   - `import()` the review's `data.ts` by file URL, deregister the hook,
     `await session.ready()`. Any peek that fails to resolve is a publish
     error, as today. After validation every `peek.resolution` is set to
     null before serialization (D9).
   - Guard: if `process.versions.node` is below 24, fail with a message
     naming the requirement rather than letting a type-stripping syntax error
     surface.
4. **Evaluate attribute expressions.** String attributes pass through;
   valueless attributes are `true`; `{expr}` attributes run as
   `new Function(...localNames, "return (expr)")` over the bound exports.
   Spread attributes are a publish error. Agent-authored code runs in the
   CLI process, the same trust boundary as today's publish gate; the call
   site says so in a comment (D10).
5. **Validate and decode.** `reviewAuthoringPropsSchemas[name].safeParse(props)`
   with the node's converted children attached where the schema requires
   them. On success the parsed output minus `children` becomes the node's
   `props`. Errors report `review.mdx:<line>`.
6. **Convert** mdast to hast with `mdast-util-to-hast`, passing through the
   JSX node types, then walk the tree replacing them with component nodes
   and run `rehype-review-targets`.
7. **Audit.** `review-publish-element-audit.ts` walks component nodes instead
   of stub React element records: trace-quote text extraction, call-stack
   evidence, peek counting. `createPublishValidationReact` is deleted.
8. **Write** `review-document.json` and `manifest.json` with
   `version: 2` and `format: "review-document/1"`. Delete any
   `review-document.js` left in the directory.

Deleted: `src/compiler/review-document-compiler.ts`, the virtual TSX program,
`src/server/doc-bundler.ts`, the stub runtime in `review-publish-evaluate.ts`,
`app/src/doc-runtime.ts` and its Vite entry, `esbuild` from runtime
dependencies. `@mdx-js/mdx` goes if nothing else uses it; the mdast, hast, and
micromark utilities stay. Whether `typescript` can leave runtime dependencies
depends on its other users (syntax validator, code-peek symbol resolution) and
is settled in the plan.

## 4. Serving and contract

- `review-bundle.ts` reads and writes the JSON artifact. A revision whose
  manifest is missing or below version 2 is reported as `needs-republish`.
- `session-handler.ts` serves `/__progressive-review/documents/<hash>.json`
  as `application/json`. The `.js` route goes away.
- `ReviewCanvasContent` stays `kind: "session"`; its document and map promises
  resolve independently to `ready`, `needs-republish`, or `unavailable` (D10).
  The existing `needs-republish` transport name is retained for the repair UI.
  An old historical revision is `unavailable`, not a current-review repair
  target. The protocol overlay is regenerated with `protocol:sync`.
- code-oss `reviewDocumentModule.ts` becomes fetch, `response.json()`, and a
  zod parse against the shared schema. `rewriteReviewDocumentRuntime`,
  `importBlobReviewModule`, the Trusted Types script-URL policy for review
  documents, and `docRuntimeUrl` in the canvas assets are deleted. The
  duplicate copy in `app/src/host/review-client.ts` is deleted with it.

## 5. App renderer

- `ReviewDocument` becomes a small renderer over `ReviewNode[]`:
  hast `element` to `createElement(tag or override, properties, children)`,
  `text` to string, `component` to `createElement(registry[name], props,
  children)`. Overrides for `a`, `pre`, and `h1` stay exactly as in
  `review-document-surface.tsx`.
- Component elements are created with the real registry functions from
  `review-authoring-components.tsx`, never wrappers, because components such
  as `DatabaseLens` may inspect children by element type.
- `createActiveReviewDocument` takes `ReviewDocumentData` and returns the
  same `ReadyReviewDocumentEntry` shape minus `Component`; `anchors` and
  `anchorContents` come straight from the data.
- `ReviewPanelProvider`'s `detailRevision` and the document boundary key use
  the artifact content hash, not the document object (D11).
- `createBrowserReviewDefinitionSession` and `setReviewRequestContext` are
  deleted from the app; code peeks resolve from the anchors table through the
  existing `/code-peek/resolve` route.
- Prose properties retain the compiler's React names (`className`,
  `data-review-block-index`); the renderer passes them through directly.

## 6. Software map as data

The map is authored as `software-map.ts` and stored in git notes by
`review map publish`, which also materializes a per-review bundle in
`.bundle/software-map/` (`head-map.js`, `base-map.js`, `manifest.json`;
`src/software-map-bundle.ts`). The server serves those files and the browser
executes `defineSoftwareMap`. This is the same "code in the app" shape and it
depends on the runtime chunk this design deletes, so it is in scope. The notes
format does not change.

- `review map publish` keeps the existing Node-side map evaluation pipeline.
  It writes `head-map.json` and `base-map.json` with a
  version-2 manifest. `elementsByPath` is not stored; the app rebuilds it from
  `elements`.
- The stored shape is `{ format: "software-map/1", elements, relationships }`;
  the model data schema lives in `software-map-model.ts`. Git notes and the
  tolerant-model materialization path remain unchanged in Phases 1–2 (D8).
- The server serves `/__progressive-review/software-maps/{head,base}-<hash>.json`.
- A genuinely absent map retains the existing authoring guidance. A stale
  currently presented map offers the same repair action as the document;
  a valid document must remain visible when only its map needs repair.
- The server process no longer bundles or executes authored code.

## 7. Migration and explicit current-presentation repair

**Automatic migration.** Schema 2/3/4 records migrate to schema 5. Evaluate
the exact sealed version-1 document bundle with `validateRanges: false` and
materialize JSON through the retained validation runtime; never recompile
`review.mdx` or `data.ts` during this operation. Recover the map from its own
presented revision, which may differ from the document revision. Preserve
valid version-2 artifacts/pointers and genuinely absent maps. A draft with no
presented document only needs its record upgraded.

Prepare all required artifacts before promoting either pointer. On failure,
restore the per-review record, authoring files, candidate bundles and private
refs; preserve the old presentation and report a blocker. Do not drop the
review, manufacture an absent map from a broken one, or update the schema to
pretend conversion succeeded. Successful migration preserves status, pins,
threads, dismissal state and publication timestamps. Repeat runs are no-ops.

These guarantees apply to the full migration command, not just artifact
conversion: later repository conversion, source audit and cleanup must not
reset presentations, destroy private history, delete threads or mutate failed
records. Preserve colocated-jj history or report an actionable blocker. All
competing CLI/server candidate, seal, record and attribution writers share the
cross-process mutation lock; a server-only lock is insufficient. Avoid nested
CLI-to-server lock acquisition and revalidate prepared revisions at promotion.

**Opening a failed conversion.** A read-only, strictly validated adapter for
supported legacy records lets Home and the current-review session show the
repair state without writing schema 5. Keep the migration warning and expose
Open recovery for that review; do not silently omit it from the list. Invalid
or unsupported records remain explicit blockers. The server never evaluates
legacy JS. Diff, Commits, Threads and any valid independent artifact remain
available where their underlying data exists; missing source commits produce
specific unavailable messages rather than fabricated content.

**Explicit repair.** Add `review repair --review <uuid> [--json]`, requiring an
explicit UUID and targeting only the current presentation. It accepts supported
legacy and current-schema records, including accepted/rejected reviews, but
only when a current artifact needs recovery. It does not take a historical
revision, re-pin, submit feedback, reopen a review, clear dismissal, or call
ordinary publish promotion. Healthy reviews return a no-op; unpresented drafts
are directed to ordinary publish.

First try exact sealed conversion. If that fails, the explicit command may
compile the review's editable `review.mdx`/`data.ts` through the retained publish
pipeline with full pinned-range/evidence validation. This source fallback is
never automatic migration: the caller must preserve what the current review
says and reconcile any unpublished authoring edits first. Compiler validation
does not prove semantic equivalence. Never overwrite authoring files with old
sources automatically. If neither usable sealed artifacts nor repairable
authoring inputs exist, report the missing inputs without altering the review.

Repair a stale map from its sealed bundle first; an explicit fallback may use
validated saved map notes for the same pinned base/head commits. Preserve an
already-valid map and do not invent a map when none was presented. A map
failure leaves the entire repair unpromoted, with actionable map diagnostics.
Prepare and validate everything before atomically promoting replacement
artifact pointers and schema 5 under the review lock; reject concurrent pointer,
pin or lifecycle changes and roll back on failure. Preserve status (including
accepted/rejected), pins, title, threads, dismissal and publication timestamps;
report old/new artifact revisions in the repair result. Ordinary `review publish`
and `review map publish` keep all existing terminal and feedback gates.

**Older history.** Keep old private commits immutable. Already-JSON historical
revisions remain readable; a pre-data historical revision shows “This older
revision is unavailable in this version of Review” and an Open current review
action. It must not offer a repair command that changes the current review.
Repairing every historical revision is explicitly out of scope.

**Repair UI (supersedes B7's initial copy).** When the current document reports
`needs-republish`, replace only the document surface. For a map-only failure,
show equivalent guidance only in Map, leaving the document ready:

- Title: "Repair this review".
- Sentence: "This review's published artifacts must be regenerated. Repair
  keeps its review status, pinned commits, and threads."
- A code-font line with the exact command and a copy button beside it:

  ```
  review repair --review <uuid>
  ```

  Use one command for document and map recovery. If the map is stale, add
  "The published software map also needs repair." No ordinary map-publish
  command is offered as a terminal-review workaround.
- A primary button, "Copy prompt", next to the command's copy button. The
  prompt:

  > Repair the currently presented Review with id `<uuid>`. Run
  > `review repair --review <uuid> --json`. If it reports validation errors,
  > fix only the reported authoring inputs without changing what the current
  > review says, then rerun. Reconcile any unpublished authoring edits before
  > using source-based repair. Preserve the review status, pinned commits,
  > and threads; do not republish or repair older historical revisions.

  When the map is stale, append: "The published software map also needs repair."
- Both buttons reuse `copyText` from `copy-text.tsx`; reuse `CopyPromptButton`.
- The Threads panel, Diff, Commits, Map, and Source tabs behave as they do
  when a document fails to load today; only the document surface is replaced.

## 8. Authoring constraints and docs

- Phase 2 keeps the existing compiler and authoring syntax. Document-local
  React components are unsupported because they cannot cross the data
  boundary; add that rule to `document-authoring.md`.
- Erasable TypeScript, one-import-only MDX, and bans on expressions/spreads
  are Phase 3 requirements only. Do not document them as current restrictions.
  Retain the tutorial's existing JSON import attribute.
- Document the JSON artifact as CDN-cacheable in the hosted architecture
  documentation. Keep the compiler/dependency descriptions until Phase 3.
  If `goal/PLAN.md` is absent, update the existing relevant architecture doc
  and report that path instead of creating an unrelated plan file.
- `docs/how-review-works.md` and `lifecycle-and-storage.md` describe
  `.bundle/document/review-document.json`.

## 9. Testing

- **Data/transport**: document/store/model round-trip tests in the owning
  progressive-review modules; transport/load-state tests in `review-protocol`.
- **Publish**: tutorial compiler/evaluator materialization and JSON schema
  tests, including all authored anchors/models; reject non-JSON values and
  document-local components. Keep existing supported authoring forms green.
  Section 3's syntax-error matrix and native-import tests belong to Phase 3.
- **Audit**: retain the element-record audit and its trace-quote/call-stack
  tests in Phase 2; materialize the audited tree without replacing the compiler.
- **Renderer**: a React DOM/jsdom test that renders the tutorial JSON and
  finds every registry component and every `data-review-block-index` block;
  the registry-schema parity test in `authoring-contract.test.tsx` gains a
  "every schema name renders" assertion.
- **Host**: `reviewDocumentModule` test becomes fetch-and-parse, including a
  version-2 manifest and a rejected version-1 one.
- **Migration/recovery**: current schema-2/3/4 presentations, split document/map
  revisions, mixed v1/v2 bundles, accepted/rejected states, byte-preserving
  rollback, idempotence, missing inputs, concurrent changes, and unchanged
  private history. An intact sealed bundle converts without authored sources.
  Failed supported records stay visible via recovery while the migration
  warning remains; invalid records stay explicit blockers.
- **Repair state**: exact command/prompt clipboard tests, map-only recovery,
  no error diagnostic for an expected recovery state, and unavailable old
  history without a misleading repair action. Ordinary terminal publish
  continues to fail before and after successful explicit repair.
- **Software map**: `review map publish` writes `head-map.json` / `base-map.json`
  into the per-review bundle; the server serves them; a version-1 bundle reads
  as needs-republish.
- **Gate**: full vitest, typecheck, `protocol:sync` clean, tutorial assets
  rebuilt (`build:tutorial-assets`), and packaged-app tutorial, migration and
  explicit-repair checks from B9. Verify threads, peeks, sequence, database
  lens, Map and terminal preservation. Record the observed preexisting
  ResizeObserver console warning without suppressing it; new errors remain
  failures. An intentionally absent map's metadata 404 is expected.

## 10. Out of scope

- Plain-JSON or Markdown-plus-sidecar authoring. Follow-up; the parser in
  section 3 step 1 is the only thing that changes.
- Trace search, threads storage, and normal review lifecycle transitions:
  untouched. The only terminal-review exception is explicit current-artifact
  repair under section 7; it does not change terminal status.
- Bulk repair/conversion of older historical revisions, automatic source
  recompilation during migration, and resurrecting missing source commits.

## 11. Phase boundaries

- Which other modules import `typescript` at runtime, and whether it can
  leave runtime dependencies.
- Whether `@mdx-js/mdx` has any remaining user after the compiler is deleted.
- Dependency removal questions above belong to Phase 3. Phase 2 keeps
  `typescript`, `@mdx-js/mdx` and esbuild, and bumps `REVIEW_SCHEMA_VERSION`
  in `review-protocol/src/contracts.ts` from 4 to 5.

## Spike evidence

Throwaway scripts in `packages/progressive-review/spike-review-data/` (deleted
at implementation start) proved, against the real tutorial review on
`origin/main`:

- native in-place `import()` of `data.ts` with `import type`, `as const`,
  `satisfies`, and a JSON sibling import: 25 ms including session ready;
- every `{expr}` attribute, including the deep store-column path, evaluates and
  validates: 14 components, 37 prose elements, 15.5 KB JSON, 0 errors;
- version-stamped URLs pick up an edited sibling in the same process;
- a worker thread costs 45 to 63 ms per publish and is not needed.
