# Review as data

Date: 2026-09-04
Status: approved in discussion, pending written review
Worktree: `../review-data-format` (branch `review-data-format`, off `origin/main` 0ad9297b)

## Goal

A published Review is a JSON document that the canvas app renders. No
agent-authored code reaches the app. Authoring stays `review.mdx` + `data.ts`
for now; a plain-JSON authoring format is a separate, later change.

## Decisions already made

| # | Decision | Rationale |
|---|---|---|
| D1 | Change the published artifact only. Authoring format unchanged. | Lands the renderer and schema first; a later authoring change becomes a parser swap. |
| D2 | Drop support for reviews sealed as JS bundles. No migration, no dual loader. | Pre-1.0. The app shows a republish state instead. |
| D3 | Produce the document from the markdown AST plus a single Node evaluation of `data.ts`. | Deletes the MDX-to-JSX compile, TypeScript transpile, virtual typecheck, and esbuild bundle. |
| D4 | Load `data.ts` in place with Node's native type stripping and a `module.registerHooks` resolve hook. No esbuild, no temp copy, no worker thread. | Node 24 is pinned for both system Node and Electron 42 (Node 24.18). Measured: 24 ms first load, about 1 ms repeat. A worker measured 45 to 63 ms and solves problems the CLI process does not have. |
| D5 | Store each component's zod-parsed props, not the raw evaluated value. | Store-column handles hide their target under a private symbol; the schema decodes it to plain JSON. |
| D6 | Version-stamp every URL under the review directory in the resolve hook. | Breaks Node's module cache on repeat evaluation in one process. Verified with an edited sibling file. |
| D7 | Zod prop validation replaces the TypeScript typecheck of authored regions. | Errors carry the MDX line from the AST node position. |
| D8 | The software map becomes data too. | It is the other agent-authored JS module the app imports, and it shares the runtime chunk being deleted. See section 6. |

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
Its zod schema lives in `@dev.fast/review-protocol` so CLI, server, and app
share one contract.

```ts
interface ReviewDocumentData {
  format: "review-document/1";
  title: string;
  slug: string;
  routePath: string;
  sourcePath: string;                       // "review.mdx"
  body: ReviewNode[];                       // rendered document
  anchors: Record<string, AnchorRef>;       // by anchor id
  anchorContents: Record<string, string>;   // authored code text per anchor id
  softwareModels: SoftwareModelData[];      // defineSoftwareModel exports
}

type ReviewNode = HastElement | HastText | ReviewComponentNode;

interface ReviewComponentNode {
  type: "component";
  name: ReviewAuthoringComponentName;       // one of the registry names
  props: Record<string, unknown>;           // zod-parsed, JSON only
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
  rewrite `##` headings to `ReviewSection` and `[label](anchors.key)` to
  `AnchorLink`.
- **Lowercase JSX tags** in prose (`<b>`, `<br />`) are HTML in MDX and become
  hast elements. Only capitalized names are components.
- `anchorContents` moves from the browser (`collectReviewAnchors`) to publish.
  Same derivation, same duplicate-content error.
- The only prop that accepts a React node is `children`; every
  `reactNodeSchema` use in `src/authoring.ts` is on `children`. JSX inside an
  attribute is therefore a publish error.

## 3. Publish pipeline

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
     `await session.ready()`.
   - Guard: if `process.versions.node` is below 24, fail with a message
     naming the requirement rather than letting a type-stripping syntax error
     surface.
4. **Evaluate attribute expressions.** String attributes pass through;
   valueless attributes are `true`; `{expr}` attributes run as
   `new Function(...localNames, "return (expr)")` over the bound exports.
   Spread attributes are a publish error. Agent-authored code runs in the
   CLI process, the same trust boundary as today's publish gate.
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
- `session-handler.ts` serves `/__progressive-review/doc-modules/<hash>.json`
  as `application/json`. The `.js` route goes away.
- `ReviewCanvasContent`'s review variant replaces `document: Promise<unknown>`
  with `document: Promise<ReviewDocumentData>` and gains a
  `{ kind: "needs-republish"; reviewId: string; title: string }` variant.
  The protocol overlay is regenerated with `protocol:sync`.
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
- `ReviewPanelProvider`'s `detailRevision`, which keys off component identity
  today, keys off the document data object.
- `createBrowserReviewDefinitionSession` and `setReviewRequestContext` are
  deleted from the app; code peeks resolve from the anchors table through the
  existing `/code-peek/resolve` route.
- hast prose properties use hast's camelCased names (`className`,
  `dataReviewBlockIndex`); the renderer maps them to React props directly.

## 6. Software map as data

The map is authored as `software-map.ts` and stored in git notes by
`review map publish`, which also materializes a per-review bundle in
`.bundle/software-map/` (`head-map.js`, `base-map.js`, `manifest.json`;
`src/software-map-bundle.ts`). The server serves those files and the browser
executes `defineSoftwareMap`. This is the same "code in the app" shape and it
depends on the runtime chunk this design deletes, so it is in scope. The notes
format does not change.

- `review map publish` evaluates the head and base `software-map.ts` sources in
  Node the same way as `data.ts`: native import, resolve hook mapping
  `@dev.fast/progressive-review/software-map-model` to the built model module,
  version-stamped URLs. It writes `head-map.json` and `base-map.json` with a
  version-2 manifest. `elementsByPath` is not stored; the app rebuilds it from
  `elements`.
- The stored shape is `{ format: "software-map/1", elements, relationships }`
  with its zod schema in `review-protocol`. The tolerant-model materialization
  path exists to keep old snapshots rendering after schema tightening; stored
  normalized JSON makes that unnecessary and it is deleted.
- The server serves `/software-map-modules/{head,base}-<hash>.json` as JSON.
- A review whose map bundle is version 1 or missing renders the Map tab's
  existing "author one with `review map`" guidance; the republish state in
  section 7 adds the `review map publish` command when the map bundle is
  stale.
- The server process no longer bundles or executes authored code.

## 7. Republish state

When the host reports `needs-republish`, the canvas renders a centered empty
state in place of the document:

- Title: "Republish this review".
- One sentence: the review was published by an earlier version and its
  document must be regenerated from its sources.
- A code-font line with the exact command, and a copy button beside it:

  ```
  review publish --review <uuid>
  ```

  When the map bundle is stale too, a second line follows with
  `review map publish --review <uuid>` and its own copy button.

- A primary button, "Copy prompt", next to the command's copy button. The
  prompt is one paragraph for an agent: republish review `<uuid>` with the
  dev-review skill by running that command, then report the result.
- Both buttons reuse `copyText` from `copy-prompt-button.tsx`, which already
  handles the workbench's clipboard restriction. The duplicate `copyText` in
  `prompt-card.tsx` is folded into the shared one.
- The Threads panel, Diff, Commits, Map, and Source tabs behave as they do
  when a document fails to load today; only the document surface is replaced.

## 8. Authoring constraints and docs

- `data.ts` must use erasable TypeScript syntax: no `enum`, `namespace`, or
  constructor parameter properties. Sibling imports must carry
  `with { type: "json" }` for JSON. The dev-review reference docs get these
  two lines; the tutorial's `data.ts` gets the JSON attribute (already done
  in the worktree).
- `review.mdx` rules become explicit in `document-authoring.md`: one import
  from `./data.ts`, no other ESM, no bare expressions, no JSX in attributes,
  no spread attributes.
- `goal/PLAN.md` D4 and the package list stop naming the MDX compiler as a
  carried-over asset; the hosted plan gains "review document JSON is CDN
  cacheable".
- `docs/how-review-works.md` and `lifecycle-and-storage.md` describe
  `.bundle/document/review-document.json`.

## 9. Testing

- **Protocol**: schema round-trip tests for `ReviewDocumentData` and
  `SoftwareMapData` in `review-protocol`.
- **Publish**: a test that publishes the tutorial review and asserts the JSON
  against a checked-in snapshot; per-rule tests for each publish error in
  section 3 (unknown component, renamed import, second import, bare
  expression, spread attribute, JSX in attribute, non-erasable syntax, Node
  version guard); a repeat-evaluate test proving edits to `data.ts` and a
  sibling are picked up in one process.
- **Audit**: existing trace-quote and call-stack tests re-pointed at component
  nodes.
- **Renderer**: a Testing Library test that renders the tutorial snapshot and
  finds every registry component and every `data-review-block-index` block;
  the registry-schema parity test in `authoring-contract.test.tsx` gains a
  "every schema name renders" assertion.
- **Host**: `reviewDocumentModule` test becomes fetch-and-parse, including a
  version-2 manifest and a rejected version-1 one.
- **Republish state**: renders the command with the uuid, both copy buttons
  call `copyText` with the expected strings.
- **Software map**: `review map publish` writes JSON to the note; the server
  serves it; a source-only note yields no map.
- **Gate**: full vitest, typecheck, `protocol:sync` clean, tutorial assets
  rebuilt (`build:tutorial-assets`), and a manual open of the tutorial review
  in the desktop app with threads, peeks, sequence, database lens, and map
  working.

## 10. Out of scope

- Plain-JSON or Markdown-plus-sidecar authoring. Follow-up; the parser in
  section 3 step 1 is the only thing that changes.
- Migrating existing sealed JS revisions. Dropped by D2.
- Trace search, threads storage, and the review lifecycle: untouched.

## 11. Items to settle in the plan

- Which other modules import `typescript` at runtime, and whether it can
  leave runtime dependencies.
- Whether `@mdx-js/mdx` has any remaining user after the compiler is deleted.
- The exact prompt text for the republish state.
- `stored-review-migration.ts` currently rebuilds bundles for legacy stores;
  under D2 it either produces the JSON artifact or marks the review
  `needs-republish`.

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
