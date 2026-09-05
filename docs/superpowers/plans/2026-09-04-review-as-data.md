# Review as data — Implementation Plan (current-presentation recovery revision)

> **For agentic workers:** Execute task-by-task with red-first tests and the gates below. Subagents are optional when useful; use Astra at medium reasoning for substantive workers, per the user's preference. Do not require unavailable superpowers skills. Steps use checkbox (`- [ ]`) syntax for tracking; completed-task instructions below are historical, not a request to replay them.

**Goal:** A published Review is JSON that the canvas app renders. No agent-authored code is imported by the app, the desktop server, or the code-oss host.

**Architecture:** Three phases. **Phase 1** writes the per-review software-map bundle as JSON and fetches it as JSON. **Phase 2** keeps the proven MDX → TypeScript → esbuild → publish-validation pipeline and adds one traversal, `materializeReviewDocument`, over the element records the validation runtime already builds; the result is JSON-round-tripped, schema-parsed, sealed, served, fetched, and rendered by a small tree renderer using the existing component registry. Current pre-data presentations are converted by `review migrate apply` running the *sealed bundle* through the same validation runtime; explicit repair handles recoverable failures. Older historical revisions are not converted. **Phase 3** (scoped here, planned separately) removes the compiler and esbuild by producing the same JSON from the markdown AST plus a native Node import of `data.ts`.

**Tech Stack:** zod 4; React 19; Hono; vitest (`// @vitest-environment jsdom` per file, `react-dom/server` or `react-dom/client`); code-oss host tests under Node's built-in runner; Node 24 (already pinned by both `engines` fields).

**Spec:** `docs/superpowers/specs/2026-09-04-review-as-data-design.md` (decisions D1–D12 as revised 2026-09-04).

## Approved recovery clarification — 2026-09-04

The user approved recovery of **only the currently presented revision**, including
accepted/rejected reviews, not every historical revision. “Current” means the
current `presentedDocumentRevision` plus its independently selected
`presentedSoftwareMapRevision`, not the source branch tip or an older selected
history entry. This amendment resolves the D2/B8 failure-recovery conflict.

- Automatic migration evaluates exact sealed bundles and never recompiles
  authoring sources. Failed conversions roll back unchanged and stay blockers.
- A read-only legacy-record adapter makes supported failures visible/openable
  for recovery while retaining the migration warning.
- Explicit `review repair --review <uuid> [--json]` may regenerate current
  artifacts, with source fallback and full validation, without changing status,
  pins, title, threads, dismissal or publication timestamps. Normal publish
  still rejects terminal reviews. See spec §7 for source and atomicity rules.
- Older pre-data history remains immutable/unavailable with an Open current
  review action, never a command that silently repairs another revision.

**Resume state (verified 2026-09-04):** A1–A4 and B1–B8b are committed;
B8 is `098d8c45`, B8a is `39fe8af9`, and B8b is `9be8756c`.
Do not redo their implementation or commits. Resume **commit B9 → PR2 → final
delivery audit**. B9's tutorial test, documentation and final audit fixes are
verified but uncommitted; packaged-app checks and final gates have passed.
B8a/B8b are the two
approved added tasks, not a new request to implement historical recovery.
B8b intentionally supersedes B7's initial publish-based recovery copy.
Goal mode subsequently resumed. B9 implementation, packaged repeat QA, exact-base
parity and final gates are now complete; commit B9 and publish the stacked PR2
with the full evidence/deviation report. Preserve the user's untracked `code-review.md`.

**Scope confirmed for the next resume:** keep the expansion limited to each
review's current document pointer and independently presented map pointer,
including terminal reviews. This is not limited to whichever historical entry
is currently selected in the UI. Do not add bulk historical repair, reopen
terminal reviews, fix unrelated shell/ResizeObserver errors, or execute Phase 3.
The spec's §7 and B8a/B8b below are the authoritative recovery requirements.

**Tracking convention:** unchecked steps in committed A/B tasks are retained
historical instructions, not outstanding work; the verified resume state above
controls execution. B9 remains outstanding. Report actual red-test evidence:
its new tutorial test initially failed on a fixture-path issue, not a demonstrated
production-renderer defect. Do not describe that as a functional red/green fix.

**Remaining B9 handoff:**
The QA portions below are verified; commit/PR delivery remains. Retain the
checklist as the acceptance record rather than replaying completed tests.
- User follow-up: keep the in-review migration/Copy prompt banner below the
  Review/Commits/Diff/Map navigation, not above it. Preserve Home's warning,
  add a red-first DOM-order regression, and verify packaged layout/scrolling.
- Finish the fresh packaged review's typed peek/navigation and prose-thread
  checks; publish its checked maps and verify the document pointer is unchanged.
- Repeat failed-migration recovery with the packaged app/CLI for current active,
  accepted and rejected reviews, plus independent map-only recovery. Verify
  clipboard text, warning clearance without reload, metadata/history preservation,
  validation/concurrency rejection, missing-input failure and healthy no-op.
- Finish and verify the full phase gate. Retain the exact-base tutorial parity
  evidence and actual unsigned/unnotarized macOS package evidence; do not
  substitute a canvas-only build or infer packaged checks from development QA.
- Audit the pending-agent-write requirement explicitly: unanswered agent input
  and concurrent durable changes are detected; general author-session liveness
  has no reliable existing API. Report this limitation rather than claiming
  that every possible running author is detected.
- Review the pending docs/test changes, commit B9 with its required subject,
  and open PR2 on the Phase 1 branch if PR1 is still open. Do not merge.

**Final B9 additions and gate:** the banner-order regression ran red/green and
passed packaged layout/scrolling/removal checks. A final server-boundary audit
found inherited strict note evaluation in map refresh; a named non-evaluating
materializer now preserves note/cache copying there, leaving strict validation
in the CLI. Refresh no longer emits that advisory warning. Actual endpoint and
packaged side-effect regressions verify neither base nor head authored code runs
in the server. Final gate passed 179 Review files/1,321 tests, typecheck, desktop
scripts and 96 host tests/protocol sync, lint, format, tutorial and diff checks.

## Global Constraints

- No new runtime dependency anywhere in Phases 1–2. No dependency removals in Phases 1–2 (esbuild, `@mdx-js/mdx`, `typescript` stay until Phase 3).
- No new authoring restriction in Phase 2: whatever compiles and validates today still publishes, except a document-local React component (`export function X()` inside `review.mdx`), which becomes a publish error because it cannot be data.
- The boundary is mechanical: publish does `reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(materialized)))`. Schemas are built from a `jsonValueSchema`, never `z.unknown()`.
- Component identity: the renderer creates elements with the functions from `reviewAuthoringComponents`, never wrappers (`DatabaseLens` checks `child.type === DbUseCase`; `ReviewSection` checks `child.type === "h2"`).
- Components stay synchronous: every code peek is resolved once before the document mounts (D9). `validatedCodePeekInputFromRef` keeps throwing on an unresolved ref.
- `ReviewCanvasContent` stays `kind: "session"`; `document` and `softwareMap` resolve to independent load states (D10). UI keyed by content hash (D11).
- Final recovery copy is exact per spec §7 and B8b: "Repair this review", command `review repair --review <uuid>`, and "Copy prompt". B7's publish/map-publish copy describes the completed intermediate step, not final acceptance.
- Work in `../review-data-format` (branch `review-data-format`). pnpm only. Commit messages without `Co-Authored-By`. Every task ends green: `pnpm --filter @dev.fast/review test`, `pnpm --filter @dev.fast/review typecheck`; for host tasks `pnpm --filter @dev.fast/review-desktop test` (its `pretest` runs `protocol:sync`). `pnpm lint && pnpm format:check` clean at the end of each phase.
- Delete the untracked spike directory `packages/progressive-review/spike-review-data/` in the first commit of Phase 2.
- Console acceptance: no new errors from this change. Record the observed preexisting `ResizeObserver loop completed with undelivered notifications` caveat; do not suppress it or expand this task to fix it. An intentionally absent map's metadata 404 is an expected response, not a renderer failure. Report all other errors explicitly.
- This console policy governs earlier task language saying "no errors" too; it does not waive unexplained errors. Expected stale-artifact 409 responses are recovery signals, not renderer failures. Record the observed missing webview/custom-editor/testing actor and unsupported terminal API errors separately: the mechanisms are inherited at the source level, but earlier-runtime reproduction and the exact extension caller are unproven. Do not silently suppress or fix unrelated shell errors under this plan.
- Never mutate real review stores during migration/repair E2E. Use a disposable HOME and DEV_REVIEW_HOME, copy/clone source repositories too, and repoint only scratch records so prepared-worktree cleanup cannot affect real repositories. Remove only validated scratch paths after testing.

## Verified facts this plan relies on (origin/main 0ad9297b)

- The publish validation runtime substitutes React with element-record builders (`src/review-publish-element-audit.ts:123-232`), invokes the document component once with a stub registry (`:252-285`), and walks the records (`:287-333`). Intrinsic tags arrive as string `type` with **React-named props** (`className`, `data-review-block-index`) because MDX compiles hast to JSX; registry components arrive as stub functions mapped by `componentNames`; fragments are `Symbol.for("react.fragment")`.
- The bundle's entry module calls the runtime's `createActiveReviewDocument({ slug, routePath, filePath, title, modelNames, models, Component, isDefault })` (`src/server/doc-bundler.ts:281-300`), so title, route, and the `data.ts` exports are available at materialization time.
- `databaseLensPropsSchema.stores` is `z.custom<StoreRef>` (`src/authoring.ts:356-364`); collection handles carry their target and schema under module-private symbols (`:287-288, 1085-1086`) that `JSON.stringify` drops. `DbRead.from` / `DbWrite.to` are decoded to plain `db-target-ref` objects by `targetRefSchema`'s preprocess.
- `peek.resolution` is read synchronously in `CodePeek.tsx:83`, `diagrams.tsx:341`, `review-components.tsx:425`, `database-lens.tsx:1022`, `call-stack-diff.tsx:68`, `thread-target-index.ts:80,131`, `sidepeek-thread-ui.tsx:318-1281`, `review-context.tsx:756-897`. Every peek lives on an `AnchorRef`.
- The software-map module is JSON in a JS wrapper (`src/software-map-bundle.ts:245-253`); `loadPublishSoftwareMaps` already imports `software-map.ts` natively (`src/software-map-health.ts:204-239`).
- Module URLs come from `/__progressive-review/doc-module` and `/software-map-module`, fetched by `reviewSessionModelService.ts:279-325`; the promises are built in `reviewCanvasPart.ts:1209-1226` and `:1501-1512`. The `/session` payload carries no module URLs.
- `ReviewErrorResponseSchema` is `{ ok: false, error }` (`contracts.ts:1260`). `REVIEW_SCHEMA_VERSION = 4` (`:37`). `rewriteReviewDocumentRuntime` is in `review-protocol/src/index.ts:164`.
- `migrateLegacyPresentedArtifacts` (`src/stored-review-migration.ts:551-663`) already materializes a sealed revision into `.build/migration-source-<nonce>` and re-seals; it is the template for Phase 2 migration.
- There is one `copyText` (`app/src/copy-text.tsx`) and a `CopyPromptButton` (`app/src/copy-prompt-button.tsx`); the home screen's `ReviewMigrationWarning` (`app/src/review-home-view.tsx:234-254`) is the pattern for the republish state.
- Tests: two vitest projects, both `environment: "node"`; DOM tests opt in with `// @vitest-environment jsdom`. No Testing Library. Run one file with `pnpm vitest run --config vitest.config.ts <file>` from `packages/progressive-review`.

## File Structure

**Phase 1 — software map as JSON**
- Modify `packages/progressive-review/src/software-map-model.ts` — `SoftwareModelData`, `softwareModelData`, `hydrateSoftwareModel`, `softwareModelDataSchema`.
- Modify `packages/progressive-review/src/software-map-bundle.ts` — JSON files, manifest v2; delete the legacy JS-bundle extractor.
- Modify `packages/progressive-review/src/server/session-handler.ts` — `/software-map` + `/software-maps/*.json`.
- Modify `packages/review-protocol/src/contracts.ts` — `ReviewSoftwareMapResponseSchema` (`headMapUrl`, `baseMapUrl`).
- Modify host: `apps/review-desktop/code-oss/src/vs/review/services/reviewSessionModelService.ts`, `.../browser/parts/canvas/reviewDocumentModule.ts`, `.../reviewCanvasPart.ts`.
- Modify `packages/progressive-review/app/src/desktop-entry.tsx` — hydrate maps.
- Modify `tutorial/runtime-manifest.json`, `scripts/check-tutorial.ts`, `apps/review-desktop/scripts/packaged-runtime.test.mjs`, `src/stored-review-migration.ts` (map recovery from the sealed `head-map.js`).

**Phase 2 — document as data through the existing pipeline**
- Create `packages/progressive-review/src/review-document-data.ts` — `jsonValueSchema`, node types, prose allowlists, `ReviewDocumentData`, schema, `stripPeekResolutions`, `walkReviewNodes`.
- Modify `packages/progressive-review/src/authoring.ts` — `StoreRefData`, `storeRefData`, `hydrateStoreRef` (symbols are module-private here).
- Create `packages/progressive-review/src/review-document-materialize.ts` — element records → `ReviewNode[]`.
- Modify `packages/progressive-review/src/review-publish-element-audit.ts` — export `flattenChildren`, `isAuditElement`, `FRAGMENT`; `auditReviewDocumentComponent` returns the tree and the component-name map.
- Modify `packages/progressive-review/src/review-publish-evaluate.ts` — result gains `document: ReviewDocumentData | null`; materialization + anchors + models + JSON round trip happen here.
- Modify `packages/progressive-review/src/review-bundle.ts` — JSON artifact, manifest v2.
- Modify `src/review-publication-preparation.ts`, `scripts/build-tutorial-assets.ts`, `scripts/check-tutorial.ts`, `tutorial/runtime-manifest.json`, `apps/review-desktop/scripts/run.sh`, `apps/review-desktop/scripts/packaged-runtime.test.mjs`.
- Modify `packages/review-protocol/src/contracts.ts` — `ReviewDocumentResponseSchema`, error `code`/`reviewUuid`/`mapStale`, `ReviewDocumentLoad`/`ReviewSoftwareMapLoad` types on the session content, `REVIEW_SCHEMA_VERSION = 5`; `index.ts` drops `rewriteReviewDocumentRuntime`.
- Modify `src/server/session-handler.ts` — `/document` + `/documents/<hash>.json`, 409 needs-republish.
- Modify host loader/service/canvas part; `apps/review-desktop/scripts/copy-canvas.mjs` (+ test); `app/desktop.vite.config.ts`; delete `app/src/doc-runtime.ts`.
- Create `app/src/review-document-hydrate.ts` (schema parse, canonical anchors, store/model hydration, pre-mount peek resolution), `app/src/review-document-renderer.tsx`, `app/src/republish-review.tsx` (+ tests).
- Modify `app/src/review-documents-runtime.ts`, `review-document-surface.tsx`, `App.tsx`, `desktop-entry.tsx`, `host/review-client.ts`, `review-definition-runtime.ts`.
- Modify `src/stored-review-migration.ts` — schema 5, convert sealed bundles.
- B8a/B8b: legacy record/recovery descriptors in `review-home.ts`, Home and session opening, CLI repair orchestration, dedicated atomic repair promotion in the server, transport/host recovery metadata, and repair UI/tests. Reuse existing validation and clipboard helpers, not ordinary publish lifecycle promotion.
- Docs: `docs/how-review-works.md`, `packages/progressive-review/skills/dev-review/references/lifecycle-and-storage.md`, `packages/progressive-review/skills/dev-review/references/document-authoring.md`. `goal/PLAN.md` is absent; document CDN-cacheable JSON in the existing architecture doc (`docs/how-review-works.md`) and report that substitution, rather than creating a goal file.

**Phase 3 — remove the compiler and esbuild** (scope only; separate plan)

---

# Phase 1 — Software map as JSON

Ships as its own PR.

### Task A1: Software-map bundle writes and reads JSON

**Files:**
- Modify: `packages/progressive-review/src/software-map-model.ts` (append after `isNormalizedSoftwareModel`, ~line 966)
- Modify: `packages/progressive-review/src/software-map-bundle.ts`
- Modify: `packages/progressive-review/src/stored-review-migration.ts:596-609` (temporary `null`, replaced in A4)
- Test: `packages/progressive-review/src/software-map-bundle.test.ts`

**Interfaces:**
- Produces (software-map-model.ts):
  ```ts
  export interface SoftwareModelData { elements: NormalizedSoftwareElement[]; relationships: NormalizedSoftwareRelationship[] }
  export function softwareModelData(model: NormalizedSoftwareModel): SoftwareModelData
  export function hydrateSoftwareModel(data: SoftwareModelData): NormalizedSoftwareModel   // rebuilds elementsByPath
  export const softwareModelDataSchema: z.ZodType<SoftwareModelData>                        // structural: elements[].path string, relationships[].from/to strings
  ```
- Produces (software-map-bundle.ts):
  ```ts
  export const SOFTWARE_MAP_DATA_FORMAT = "software-map/1";
  export interface ReviewSoftwareMapBundle { head: SoftwareModelData; base: SoftwareModelData; headJson: string; baseJson: string; contentHash: string; headCommit: string; baseCommit: string }
  export function bundleReviewSoftwareMap(input: { head: NormalizedSoftwareModel; base: NormalizedSoftwareModel; headCommit: string; baseCommit: string }): ReviewSoftwareMapBundle
  export async function writeReviewSoftwareMapBundle(reviewDir: string, bundle: ReviewSoftwareMapBundle): Promise<void>   // head-map.json, base-map.json, manifest {version: 2, headCommit, baseCommit}
  export async function readReviewSoftwareMapBundle(rootDir: string): Promise<ReviewSoftwareMapBundle | null>            // null on ENOENT or manifest.version !== 2
  export function sameReviewSoftwareMapBundle(left, right): boolean
  ```
  `extractLegacyReviewSoftwareMapBundle`, `DocumentModuleSchema`, `EvaluatedDocumentSchema`, and the `es-module-lexer` import leave this file.

**Success criteria:**
- `readReviewSoftwareMapBundle` returns a value deep-equal to what `writeReviewSoftwareMapBundle` wrote, and `hydrateSoftwareModel(read.head).elementsByPath` equals the original model's map.
- A version-1 (JavaScript) bundle reads as `null`; no `.js` file is written; `head-map.json` contains `format`, `elements`, `relationships` and no `elementsByPath`.
- `grep -rn "headCode\|baseCode" packages/progressive-review/src` hits only `server/session-handler.ts`; `es-module-lexer` is no longer imported by `software-map-bundle.ts`.

**End-to-end check:** `pnpm --filter @dev.fast/review build:tutorial-assets` succeeds and `ls packages/progressive-review/tutorial/.bundle/software-map` lists exactly `base-map.json head-map.json manifest.json`, with `jq .version …/manifest.json` printing `2`. (The tutorial builder already goes through `bundleReviewSoftwareMap` + `writeReviewSoftwareMapBundle`.)

- [ ] **Step 1: Write the failing tests** — replace `software-map-bundle.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  sameReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap, hydrateSoftwareModel } from "./software-map-model";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("software map bundle", () => {
  it("writes head and base maps as JSON and reads them back", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-map-bundle-"));
    const head = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const base = defineSoftwareMap({ systems: { api: { label: "API" } } });
    const bundle = bundleReviewSoftwareMap({ head, base, headCommit: "a".repeat(40), baseCommit: "b".repeat(40) });

    await writeReviewSoftwareMapBundle(directory, bundle);

    const read = await readReviewSoftwareMapBundle(directory);
    expect(read).toEqual(bundle);
    const headFile = JSON.parse(await readFile(path.join(directory, REVIEW_SOFTWARE_MAP_BUNDLE_DIR, "head-map.json"), "utf8"));
    expect(headFile.format).toBe("software-map/1");
    expect(headFile.elements.map((e: { path: string }) => e.path)).toEqual(head.elements.map((e) => e.path));
    expect(hydrateSoftwareModel(read!.head).elementsByPath.get("app")).toEqual(head.elementsByPath.get("app"));
    expect(sameReviewSoftwareMapBundle(read!, bundle)).toBe(true);
  });

  it("returns null for a version-1 (JavaScript) bundle", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-map-bundle-"));
    const bundleDir = path.join(directory, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify({ version: 1, headCommit: "a".repeat(40), baseCommit: "b".repeat(40) }));
    await writeFile(path.join(bundleDir, "head-map.js"), "export default {}");
    await writeFile(path.join(bundleDir, "base-map.js"), "export default {}");

    await expect(readReviewSoftwareMapBundle(directory)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run --config vitest.config.ts src/software-map-bundle.test.ts` → FAIL (`hydrateSoftwareModel` not exported).

- [ ] **Step 3: Add data helpers to `software-map-model.ts`**

```ts
/** JSON projection of a normalized model. `elementsByPath` is derived and is
    rebuilt on load by `hydrateSoftwareModel`. */
export interface SoftwareModelData {
  elements: NormalizedSoftwareElement[];
  relationships: NormalizedSoftwareRelationship[];
}

export function softwareModelData(model: NormalizedSoftwareModel): SoftwareModelData {
  return { elements: model.elements, relationships: model.relationships };
}

export function hydrateSoftwareModel(data: SoftwareModelData): NormalizedSoftwareModel {
  return {
    elements: data.elements,
    relationships: data.relationships,
    elementsByPath: new Map(data.elements.map((element) => [element.path, element])),
  };
}

export const softwareModelDataSchema: z.ZodType<SoftwareModelData> = z.object({
  elements: z.array(
    z.custom<NormalizedSoftwareElement>((value) => isObjectValue(value) && typeof (value as { path?: unknown }).path === "string", "software element"),
  ),
  relationships: z.array(
    z.custom<NormalizedSoftwareRelationship>((value) => isObjectValue(value) && typeof (value as { from?: unknown }).from === "string", "software relationship"),
  ),
});
```
(`z` and `isObjectValue` are already imported in this file — check with `grep -n "^import" src/software-map-model.ts`.)

- [ ] **Step 4: Rewrite `software-map-bundle.ts`**

```ts
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { type NormalizedSoftwareModel, type SoftwareModelData, softwareModelData, softwareModelDataSchema } from "./software-map-model";

export const REVIEW_SOFTWARE_MAP_BUNDLE_DIR = path.join(".bundle", "software-map");
export const SOFTWARE_MAP_DATA_FORMAT = "software-map/1";
const HEAD_MAP_FILE = "head-map.json";
const BASE_MAP_FILE = "base-map.json";
const MANIFEST_FILE = "manifest.json";
// Version 1 wrote ES modules (head-map.js / base-map.js). Version 2 writes
// JSON; a version-1 bundle reads as null and `review migrate apply` converts it.
const MANIFEST_VERSION = 2;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const SoftwareMapBundleManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  headCommit: z.string().regex(COMMIT_SHA_PATTERN),
  baseCommit: z.string().regex(COMMIT_SHA_PATTERN),
});
type SoftwareMapBundleManifest = z.infer<typeof SoftwareMapBundleManifestSchema>;
const SoftwareMapDataFileSchema = z.object({ format: z.literal(SOFTWARE_MAP_DATA_FORMAT) }).and(softwareModelDataSchema);

export interface ReviewSoftwareMapBundle {
  head: SoftwareModelData;
  base: SoftwareModelData;
  headJson: string;
  baseJson: string;
  contentHash: string;
  headCommit: string;
  baseCommit: string;
}

export function bundleReviewSoftwareMap(input: { head: NormalizedSoftwareModel; base: NormalizedSoftwareModel; headCommit: string; baseCommit: string }): ReviewSoftwareMapBundle {
  const head = softwareModelData(input.head);
  const base = softwareModelData(input.base);
  const headJson = softwareMapDataJson(head);
  const baseJson = softwareMapDataJson(base);
  return { head, base, headJson, baseJson, contentHash: bundleHash(headJson, baseJson), headCommit: input.headCommit, baseCommit: input.baseCommit };
}

export async function writeReviewSoftwareMapBundle(reviewDir: string, bundle: ReviewSoftwareMapBundle): Promise<void> {
  const bundleDir = path.join(reviewDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
  await mkdir(bundleDir, { recursive: true, mode: 0o700 });
  const manifest: SoftwareMapBundleManifest = { version: MANIFEST_VERSION, headCommit: bundle.headCommit, baseCommit: bundle.baseCommit };
  await Promise.all([
    writeFile(path.join(bundleDir, HEAD_MAP_FILE), bundle.headJson, "utf8"),
    writeFile(path.join(bundleDir, BASE_MAP_FILE), bundle.baseJson, "utf8"),
    writeFile(path.join(bundleDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
}

export async function readReviewSoftwareMapBundle(rootDir: string): Promise<ReviewSoftwareMapBundle | null> {
  const bundleDir = path.join(rootDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(bundleDir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const manifest = parseJson(manifestRaw, SoftwareMapBundleManifestSchema);
  if (!manifest) return null;
  const [headJson, baseJson] = await Promise.all([
    readFile(path.join(bundleDir, HEAD_MAP_FILE), "utf8"),
    readFile(path.join(bundleDir, BASE_MAP_FILE), "utf8"),
  ]);
  const head = parseJson(headJson, SoftwareMapDataFileSchema);
  const base = parseJson(baseJson, SoftwareMapDataFileSchema);
  if (!head || !base) return null;
  return {
    head: { elements: head.elements, relationships: head.relationships },
    base: { elements: base.elements, relationships: base.relationships },
    headJson, baseJson,
    contentHash: bundleHash(headJson, baseJson),
    headCommit: manifest.headCommit,
    baseCommit: manifest.baseCommit,
  };
}

export function sameReviewSoftwareMapBundle(left: ReviewSoftwareMapBundle, right: ReviewSoftwareMapBundle): boolean {
  return left.headJson === right.headJson && left.baseJson === right.baseJson && left.headCommit === right.headCommit && left.baseCommit === right.baseCommit;
}

function softwareMapDataJson(data: SoftwareModelData): string {
  return `${JSON.stringify({ format: SOFTWARE_MAP_DATA_FORMAT, ...data })}\n`;
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let value: JsonValue;
  try { value = parseJsonText(raw); } catch { return null; }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function bundleHash(headJson: string, baseJson: string): string {
  return crypto.createHash("sha256").update(headJson).update("\0").update(baseJson).digest("hex").slice(0, 20);
}
```

- [ ] **Step 5: Fix compile errors** — in `stored-review-migration.ts:596-609` replace the `legacyBundleCode` read and the `extractLegacyReviewSoftwareMapBundle` call with `const mapBundle: ReviewSoftwareMapBundle | null = null;` (import the type). `pnpm --filter @dev.fast/review typecheck`; `grep -rn "headCode\|baseCode" packages/progressive-review/src` must only hit `session-handler.ts` (fixed in A2).

- [ ] **Step 6: Run** — `pnpm vitest run --config vitest.config.ts src/software-map-bundle.test.ts` → PASS (2).

- [ ] **Step 7: Commit**

```bash
git add packages/progressive-review/src/software-map-model.ts packages/progressive-review/src/software-map-bundle.ts packages/progressive-review/src/software-map-bundle.test.ts packages/progressive-review/src/stored-review-migration.ts
git commit -m "Write the review software-map bundle as JSON"
```

### Task A2: Server serves map JSON; protocol response renamed

**Files:**
- Modify: `packages/review-protocol/src/contracts.ts:1716-1730`
- Modify: `packages/progressive-review/src/server/session-handler.ts:42, 290-333`
- Test: `packages/progressive-review/src/server/session-handler.test.ts`

**Interfaces:**
- Produces (contracts.ts), replacing `ReviewSoftwareMapModuleResponseSchema`:
  ```ts
  export const ReviewSoftwareMapResponseSchema = z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), contentHash: requiredString, headMapUrl: absoluteUrlSchema, baseMapUrl: absoluteUrlSchema }),
    ReviewErrorResponseSchema,
  ]);
  export type ReviewSoftwareMapResponse = z.infer<typeof ReviewSoftwareMapResponseSchema>;
  ```
- Routes: `GET /__progressive-review/software-map` → that response (404 `Software map is not published` when the bundle is null); `GET /__progressive-review/software-maps/head-<hash>.json` and `base-<hash>.json` → `application/json; charset=utf-8`, `cache-control: no-store`.

**Success criteria:**
- `GET /__progressive-review/software-map` returns `{ ok: true, contentHash, headMapUrl, baseMapUrl }` with both URLs ending in `.json`; returns 404 `Software map is not published` when the bundle is null.
- `GET /__progressive-review/software-maps/head-<hash>.json` and `base-<hash>.json` return `application/json; charset=utf-8`, `cache-control: no-store`, a body whose `format` is `software-map/1`; any other name returns 404.
- `ReviewSoftwareMapModuleResponseSchema` no longer exists anywhere (`grep -rn ReviewSoftwareMapModuleResponseSchema packages apps` is empty after A3).

**End-to-end check:** covered by the handler test, which drives the real Hono app over real files. The live-app check is in A3 (the host is still on the old route until then).

- [ ] **Step 1: Failing server test** — add next to the doc-module test (`:230-262`), mirroring its full `createReviewSessionHandler` argument shape (it has more required fields than shown; copy them):

```ts
  it("serves the published software map as JSON", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const head = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const base = defineSoftwareMap({ systems: { api: { label: "API" } } });
    await writeReviewSoftwareMapBundle(rootPath, bundleReviewSoftwareMap({ head, base, headCommit: "a".repeat(40), baseCommit: "b".repeat(40) }));
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices, rootPath, toolingRoot: rootPath, reviewPath, softwareMapRootPath: rootPath, routePath: "/", token,
      session: { rootPath, baseRef: "HEAD", appUrl: sessionUrl, reviewPath, startedAt: Date.now() },
    });
    try {
      const index = await handler.handle(new Request(new URL("/__progressive-review/software-map", sessionUrl), { headers: { "x-review-token": token } }));
      expect(index.status).toBe(200);
      const payload = (await index.json()) as { ok: true; headMapUrl: string };
      expect(payload.headMapUrl).toMatch(/\/software-maps\/head-[0-9a-f]{20}\.json$/);
      const headResponse = await handler.handle(new Request(payload.headMapUrl, { headers: { "x-review-token": token } }));
      expect(headResponse.headers.get("content-type")).toContain("application/json");
      const headJson = (await headResponse.json()) as { format: string; elements: Array<{ path: string }> };
      expect(headJson.format).toBe("software-map/1");
      expect(headJson.elements.map((e) => e.path)).toEqual(["app"]);
    } finally {
      await handler.close();
    }
  });
```
Imports: `bundleReviewSoftwareMap`, `writeReviewSoftwareMapBundle` from `../software-map-bundle`; `defineSoftwareMap` from `../software-map-model`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run --config vitest.config.ts src/server/session-handler.test.ts -t "software map as JSON"` → 404.

- [ ] **Step 3: Protocol** — replace lines 1716-1730 of `contracts.ts` with the schema above; `pnpm --filter @dev.fast/review-protocol build`.

- [ ] **Step 4: Server** — `session-handler.ts:42` → `const MAP_PATH_PREFIX = \`${API_PREFIX}/software-maps/\`;`; replace lines 290-333 with:

```ts
  app.get(`${API_PREFIX}/software-map`, async () => {
    const bundle = await getSoftwareMapBundle();
    if (!bundle) return jsonResponse({ ok: false, error: "Software map is not published" }, 404);
    return jsonResponse({
      ok: true,
      contentHash: bundle.contentHash,
      headMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}head-${bundle.contentHash}.json`,
      baseMapUrl: `${sessionUrl}${MAP_PATH_PREFIX}base-${bundle.contentHash}.json`,
    }, 200);
  });
  app.get(`${MAP_PATH_PREFIX}:mapName`, async (context) => {
    const bundle = await getSoftwareMapBundle();
    const mapName = context.req.param("mapName");
    const json = mapName === `head-${bundle?.contentHash}.json` ? bundle?.headJson
      : mapName === `base-${bundle?.contentHash}.json` ? bundle?.baseJson : undefined;
    if (!json) return jsonResponse({ ok: false, error: "Software map not found" }, 404);
    return new Response(json, { status: 200, headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
  });
```

- [ ] **Step 5: Run** — `pnpm vitest run --config vitest.config.ts src/server/session-handler.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/review-protocol/src/contracts.ts packages/progressive-review/src/server/session-handler.ts packages/progressive-review/src/server/session-handler.test.ts
git commit -m "Serve the software map as JSON"
```

### Task A3: Host fetches map JSON; app hydrates it

**Files:**
- Modify: `apps/review-desktop/code-oss/src/vs/review/services/reviewSessionModelService.ts:54-58, 303-325`
- Modify: `apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewDocumentModule.ts` (delete `softwareMapModules`, `loadReviewSoftwareMapModules`, `loadSoftwareMapModule`, `unwrapDefault`; add `loadReviewSoftwareMaps` + `fetchReviewJson`)
- Modify: `apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts:1216-1226, ~1510`
- Modify: `packages/progressive-review/app/src/desktop-entry.tsx:86-90`

**Interfaces:**
```ts
// reviewSessionModelService.ts
export type ReviewSoftwareMapLoader = (session: ReviewDesktopSession, headMapUrl: string, baseMapUrl: string) => Promise<unknown>;
// reviewDocumentModule.ts
export async function loadReviewSoftwareMaps(session: ReviewDesktopSession, headMapUrl: string, baseMapUrl: string): Promise<{ head: unknown; base: unknown }>
export async function fetchReviewJson(session: ReviewDesktopSession, url: string, label: string): Promise<unknown>   // reused by Phase 2
```

**Success criteria:**
- `pnpm --filter @dev.fast/review-desktop test` and `pnpm --filter @dev.fast/review typecheck` pass after `protocol:sync`.
- `grep -n "createObjectURL" apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewDocumentModule.ts` shows only the document path (removed entirely in B5); no `Blob` is created for maps.
- In the app, `PublishedSoftwareMap.head.elementsByPath instanceof Map` (assert in `desktop-entry` via the existing jsdom test for the entry, or a new one that calls `hydratePublishedSoftwareMap`).

**End-to-end check:** run the desktop app from this worktree (`run` skill / `apps/review-desktop/scripts/run.sh`), open the tutorial review, switch to the **Map** tab: the "Order service" system renders with its containers, the base/head topology diff badges appear, and the canvas console shows no errors. Then open the network log in the workbench devtools and confirm the map requests are `…/software-maps/head-<hash>.json` with `content-type: application/json`.

- [ ] **Step 1: Regenerate the overlay** — `pnpm --filter @dev.fast/review-desktop protocol:sync`; the host now fails to typecheck on the old schema name (the failing state).

- [ ] **Step 2: Host loader**

```ts
export async function loadReviewSoftwareMaps(session: ReviewDesktopSession, headMapUrl: string, baseMapUrl: string): Promise<{ head: unknown; base: unknown }> {
	const [head, base] = await Promise.all([
		fetchReviewJson(session, headMapUrl, "Software map"),
		fetchReviewJson(session, baseMapUrl, "Software map"),
	]);
	return { head, base };
}

export async function fetchReviewJson(session: ReviewDesktopSession, url: string, label: string): Promise<unknown> {
	const target = new URL(url, session.serverUrl);
	const response = await fetch(target, { headers: session.token ? { "x-review-token": session.token } : undefined });
	if (!response.ok) throw new Error(`${label} returned ${response.status}.`);
	return response.json();
}
```
In `reviewSessionModelService.ts`: rename the loader type; `loadReviewSessionSoftwareMap` fetches `/__progressive-review/software-map`, parses with `ReviewSoftwareMapResponseSchema`, calls `loader(session, payload.headMapUrl, payload.baseMapUrl)`. In `reviewCanvasPart.ts` both call sites use `loadReviewSoftwareMaps`.

- [ ] **Step 3: App hydration** — `desktop-entry.tsx:86-90`:

```ts
        const maps = softwareMapValue as { head: unknown; base: unknown } | null;
        setSoftwareMap(maps ? hydratePublishedSoftwareMap(maps) : null);
```
plus, at module scope:
```ts
import { hydrateSoftwareModel, softwareModelDataSchema } from "./software-map/model";

function hydratePublishedSoftwareMap(maps: { head: unknown; base: unknown }): PublishedSoftwareMap {
  return { head: hydrateSoftwareModel(softwareModelDataSchema.parse(maps.head)), base: hydrateSoftwareModel(softwareModelDataSchema.parse(maps.base)) };
}
```
`app/src/software-map/model.ts` re-exports `../../../src/software-map-model` (confirm with `head -5`); add the two names to its export list if it is selective.

- [ ] **Step 4: Verify** — `pnpm --filter @dev.fast/review typecheck && pnpm --filter @dev.fast/review-desktop test && pnpm --filter @dev.fast/review test`.

- [ ] **Step 5: Commit**

```bash
git add -A apps/review-desktop/code-oss/src/vs/review packages/progressive-review/app/src
git commit -m "Load the software map as JSON in the desktop host"
```

### Task A4: Tutorial assets, packaging checks, migration map recovery

**Files:**
- Modify: `packages/progressive-review/tutorial/runtime-manifest.json:12-13`, `scripts/check-tutorial.ts` (map manifest `version !== 2`; read `head-map.json`, assert `format`), `apps/review-desktop/scripts/packaged-runtime.test.mjs:235-245`.
- Modify: `packages/progressive-review/src/stored-review-migration.ts:596-609`
- Test: `packages/progressive-review/src/stored-review-migration.test.ts` (existing schema-2 case: assert the migrated bundle has `head-map.json`).

**Success criteria:**
- `pnpm --filter @dev.fast/review check:tutorial` passes and asserts `head-map.json` has `format: "software-map/1"`; `packaged-runtime.test.mjs` passes with the `.json` names.
- `stored-review-migration.test.ts`: a schema-2 review whose sealed revision contains version-1 `head-map.js`/`base-map.js` comes out with `.bundle/software-map/head-map.json` and `presentedSoftwareMapRevision` set; a review whose legacy map files are missing comes out with `presentedSoftwareMapRevision: null` and no blocker.

**End-to-end check:** copy the real store to a scratch home (`cp -R ~/.dev/reviews /tmp/review-home-a4/reviews`), run the migration with the app runtime (`DEV_REVIEW_HOME=/tmp/review-home-a4 review migrate apply`), then launch the app with `DEV_REVIEW_HOME=/tmp/review-home-a4` and open a migrated review that had a map: the Map tab renders. Delete the scratch home afterwards.

**Phase 1 gate (before the PR):** `pnpm --filter @dev.fast/review test`, `pnpm --filter @dev.fast/review typecheck`, `pnpm --filter @dev.fast/review-desktop test`, `pnpm lint && pnpm format:check`, `pnpm --filter @dev.fast/review check:tutorial`, and a packaged build (`SKIP_NOTARIZE=1 pnpm --filter @dev.fast/review-desktop app:package:macos` for local macOS QA, or the platform CI packaging script) whose app opens the tutorial with a working Map tab.

- [ ] **Step 1: Tutorial and packaging references** as listed.

- [ ] **Step 2: Migration recovers the map from the sealed artifact** (D2: sealed artifacts, not sources). The legacy `head-map.js` / `base-map.js` are our own generated modules with no imports (`software-map-bundle.ts:245-253` on `main`), so import them directly:

```ts
async function legacySoftwareMapBundle(legacyBuildDir: string, headCommit: string, baseCommit: string): Promise<ReviewSoftwareMapBundle | null> {
  const mapDir = path.join(legacyBuildDir, ".bundle", "software-map");
  const load = async (file: string): Promise<NormalizedSoftwareModel | null> => {
    const url = pathToFileURL(path.join(mapDir, file));
    url.searchParams.set("t", String(Date.now()));
    try {
      const module = (await import(url.href)) as { default?: unknown };
      return isNormalizedSoftwareModel(module.default) ? module.default : null;
    } catch {
      return null;
    }
  };
  const [head, base] = await Promise.all([load("head-map.js"), load("base-map.js")]);
  if (!head || !base) return null;
  return bundleReviewSoftwareMap({ head, base, headCommit, baseCommit });
}
```
Call it where A1 left `null`: `input.review.sourceCommit ? await legacySoftwareMapBundle(legacyBuildDir, input.review.sourceCommit, input.review.baseCommit) : null` (confirm the record field names with `grep -n "sourceCommit\|baseCommit" src/stored-review-migration.ts`). Imports: `pathToFileURL`, `isNormalizedSoftwareModel`, `bundleReviewSoftwareMap`.

- [ ] **Step 3: Rebuild and run everything** — `pnpm --filter @dev.fast/review build:tutorial-assets && pnpm --filter @dev.fast/review check:tutorial && pnpm --filter @dev.fast/review test && pnpm --filter @dev.fast/review-desktop test && pnpm lint && pnpm format:check`.

- [ ] **Step 4: Commit and PR**

```bash
git add -A
git commit -m "Ship tutorial and migration map bundles as JSON"
```
PR "Software map bundle as JSON" against `main`.

---

# Phase 2 — Review document as data (existing pipeline + materialization)

### Task B1: Document data schema and store-handle data

**Files:**
- Create: `packages/progressive-review/src/review-document-data.ts`
- Modify: `packages/progressive-review/src/authoring.ts` (append near `collectionSchema`, ~line 660)
- Test: `packages/progressive-review/src/review-document-data.test.ts`, `packages/progressive-review/src/authoring.test.ts` (add a store round-trip case)

**Interfaces:**
- Produces (authoring.ts):
  ```ts
  export interface CollectionRefData { target: TargetRef; schema: SoftwareDataStoreFieldSchema }
  export interface StoreRefData { __kind: "db-store-ref"; id: string; kind: StoreKind; label: string; dataStoreKind?: SoftwareDataStoreKind; softwareMapPath?: string; tables?: Record<string, CollectionRefData>; documents?: Record<string, CollectionRefData> }
  export function storeRefData(store: StoreRef): StoreRefData             // via collectionTargetRef / collectionSchema
  export function hydrateStoreRef(data: StoreRefData): StoreRef           // rebuilds CollectionRef handles with the symbol-keyed target and schema
  export const storeRefDataSchema: z.ZodType<StoreRefData>
  ```
- Produces (review-document-data.ts):
  ```ts
  export const REVIEW_DOCUMENT_FORMAT = "review-document/1";
  export const jsonValueSchema: z.ZodType<JsonValue>;
  export const PROSE_TAGS: readonly string[];       // p h1 h2 h3 h4 h5 h6 ul ol li a strong em del code pre blockquote hr br table thead tbody tr th td input img
  export type ReviewElementProps = Record<string, string | number | boolean>;
  export interface ReviewTextNode { type: "text"; value: string }
  export interface ReviewElementNode { type: "element"; tag: string; props: ReviewElementProps; children: ReviewNode[] }
  export interface ReviewComponentNode { type: "component"; name: ReviewAuthoringComponentName; props: Record<string, JsonValue>; children: ReviewNode[] }
  export type ReviewNode = ReviewTextNode | ReviewElementNode | ReviewComponentNode;
  export type ReviewAuthoringComponentName = keyof typeof reviewAuthoringPropsSchemas;
  export interface ReviewDocumentData { format; title: string; routePath: string; sourcePath: string; body: ReviewNode[]; anchors: Record<string, AnchorRef>; anchorContents: Record<string, string>; softwareModels: SoftwareModelData[] }
  export const reviewDocumentDataSchema: z.ZodType<ReviewDocumentData>;
  export function stripPeekResolutions<T>(value: T): T;   // deep copy; every {__kind:"code-peek-ref"}.resolution = null
  export function walkReviewNodes(nodes: ReviewNode[], visit: (node: ReviewNode, parent: ReviewComponentNode | null) => void): void;
  ```
  Element props schema: keys ∈ {`className`, `href`, `title`, `id`, `align`, `checked`, `disabled`, `start`, `type`, `alt`, `src`} ∪ `/^data-review-/`; `href`/`src` values must match `/^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/` (no other protocol). `DatabaseLens` component props validate `stores` with `z.record(storeRefDataSchema)`; every other component's props are `z.record(z.string(), jsonValueSchema)`.

**Success criteria:**
- `reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(document)))` deep-equals `document` for a document using an element with `data-review-*` props and a `CodePeek` with an inlined anchor.
- The schema rejects: an unknown component name, a tag outside `PROSE_TAGS`, a prop outside the allowlist, an `href` with a non-allowlisted protocol, a `DatabaseLens` whose collection lacks `schema`/`target`.
- `storeRefData` → JSON → `hydrateStoreRef` restores `collectionSchema(...)` and field targets (`resolveTargetRef(hydrated.tables.orders.status).path` equals `["status"]`).

**End-to-end check:** none on its own; this is a pure module. It is exercised end to end by B2's tutorial materialization test.

- [ ] **Step 1: Failing tests**

`review-document-data.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { REVIEW_DOCUMENT_FORMAT, reviewDocumentDataSchema, stripPeekResolutions, walkReviewNodes } from "./review-document-data";

const anchor = { __kind: "db-anchor-ref", id: "a", title: "A", peek: { __kind: "code-peek-ref", props: { file: "x.ts", fromLine: 1, toLine: 2 }, resolution: null } };
const base = { format: REVIEW_DOCUMENT_FORMAT, title: "T", routePath: "/", sourcePath: "review.mdx", anchors: { a: anchor }, anchorContents: {}, softwareModels: [] };

describe("review document data", () => {
  it("round-trips a document through JSON and the schema", () => {
    const document = { ...base, body: [
      { type: "element", tag: "h1", props: { "data-review-block-index": 0, "data-review-block-tag": "h1" }, children: [{ type: "text", value: "T" }] },
      { type: "component", name: "CodePeek", props: { anchor }, children: [] },
    ] };
    expect(reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });
  it("rejects an unknown component, a non-prose tag, a stray prop, and a javascript: href", () => {
    for (const body of [
      [{ type: "component", name: "Nope", props: {}, children: [] }],
      [{ type: "element", tag: "script", props: {}, children: [] }],
      [{ type: "element", tag: "p", props: { onClick: "x" }, children: [] }],
      [{ type: "element", tag: "a", props: { href: "javascript:alert(1)" }, children: [] }],
    ]) {
      expect(reviewDocumentDataSchema.safeParse({ ...base, body }).success).toBe(false);
    }
  });
  it("rejects DatabaseLens stores that lost their collection schema", () => {
    const body = [{ type: "component", name: "DatabaseLens", props: { stores: { db: { __kind: "db-store-ref", id: "db", kind: "relational", label: "DB", tables: { orders: {} } } } }, children: [] }];
    expect(reviewDocumentDataSchema.safeParse({ ...base, body }).success).toBe(false);
  });
  it("strips peek resolutions deeply without mutating the input", () => {
    const peek = Object.freeze({ __kind: "code-peek-ref", props: { file: "x.ts", fromLine: 1, toLine: 1 }, resolution: { snapshot: {} } });
    const input = { list: [{ anchor: { peek } }] };
    const stripped = stripPeekResolutions(input);
    expect(stripped.list[0].anchor.peek.resolution).toBeNull();
    expect(input.list[0].anchor.peek.resolution).not.toBeNull();
  });
  it("walks components with their parent", () => {
    const seen: string[] = [];
    walkReviewNodes([{ type: "component", name: "DatabaseLens", props: {}, children: [{ type: "component", name: "DbUseCase", props: {}, children: [] }] }],
      (node, parent) => { if (node.type === "component") seen.push(`${parent?.name ?? "root"}>${node.name}`); });
    expect(seen).toEqual(["root>DatabaseLens", "DatabaseLens>DbUseCase"]);
  });
});
```
`authoring.test.ts` addition:
```ts
  it("round-trips store handles through JSON data", () => {
    const session = createReviewDefinitionSession({ softwareMap: null, baseSoftwareMap: null });
    const stores = session.defineStores({ db: { kind: "relational", label: "DB", tables: { orders: { label: "orders", schema: { id: { type: "text", pk: true }, status: { type: "text" } } } } } });
    const data = JSON.parse(JSON.stringify(storeRefData(stores.db))) as StoreRefData;
    expect(data.tables?.orders.target).toMatchObject({ __kind: "db-target-ref", storeId: "db", collectionId: "orders", path: [] });
    const hydrated = hydrateStoreRef(data);
    expect(collectionSchema(hydrated.tables!.orders)).toEqual({ id: { type: "text", pk: true }, status: { type: "text" } });
    expect(resolveTargetRef(hydrated.tables!.orders.status)).toMatchObject({ collectionId: "orders", path: ["status"] });
  });
```

- [ ] **Step 2: Run to verify failure** — both files fail on missing exports.

- [ ] **Step 3: Implement in `authoring.ts`** — refactor `defineCollections` so the handle construction is reusable:

```ts
function collectionRefFromTarget(target: TargetRef, schema: SoftwareDataStoreFieldSchema): CollectionRef {
  const fields = defineFieldTargets(target, schema, []);
  // SAFETY: the handle's symbol-keyed target and schema are defined on the
  // next statement, before the collection ref escapes.
  const authored = Object.assign({}, fields) as CollectionRef;
  Object.defineProperties(authored, {
    [authoredTargetRefKey]: { value: Object.freeze(target) },
    [collectionSchemaKey]: { value: schema },
  });
  return Object.freeze(authored);
}
```
(`defineCollections` builds `target` then returns `[collectionId, collectionRefFromTarget(target, collection.schema)]`.) Then:

```ts
export interface CollectionRefData { target: TargetRef; schema: SoftwareDataStoreFieldSchema }
export interface StoreRefData { /* as in Interfaces */ }

export function storeRefData(store: StoreRef): StoreRefData {
  const collections = (refs?: Record<string, CollectionRef>) =>
    refs && Object.fromEntries(Object.entries(refs).map(([id, ref]) => [id, { target: collectionTargetRef(ref), schema: collectionSchema(ref) }]));
  return {
    __kind: "db-store-ref", id: store.id, kind: store.kind, label: store.label,
    ...(store.dataStoreKind ? { dataStoreKind: store.dataStoreKind } : {}),
    ...(store.softwareMapPath ? { softwareMapPath: store.softwareMapPath } : {}),
    ...(store.tables ? { tables: collections(store.tables) } : {}),
    ...(store.documents ? { documents: collections(store.documents) } : {}),
  };
}

export function hydrateStoreRef(data: StoreRefData): StoreRef {
  const collections = (refs?: Record<string, CollectionRefData>) =>
    refs && Object.fromEntries(Object.entries(refs).map(([id, ref]) => [id, collectionRefFromTarget(ref.target, ref.schema)]));
  return Object.freeze({
    __kind: "db-store-ref", id: data.id, kind: data.kind, label: data.label,
    ...(data.dataStoreKind ? { dataStoreKind: data.dataStoreKind } : {}),
    ...(data.softwareMapPath ? { softwareMapPath: data.softwareMapPath } : {}),
    ...(data.tables ? { tables: collections(data.tables) } : {}),
    ...(data.documents ? { documents: collections(data.documents) } : {}),
  }) as StoreRef;
}

const collectionRefDataSchema = z.strictObject({ target: resolvedTargetRefSchema, schema: softwareDataStoreFieldSchemaSchema });
export const storeRefDataSchema: z.ZodType<StoreRefData> = z.strictObject({
  __kind: z.literal("db-store-ref"), id: nonEmptyStringSchema, kind: storeKindSchema, label: nonEmptyStringSchema,
  dataStoreKind: softwareDataStoreKindSchema.optional(), softwareMapPath: optionalNonEmptyStringSchema,
  tables: z.record(nonEmptyStringSchema, collectionRefDataSchema).optional(),
  documents: z.record(nonEmptyStringSchema, collectionRefDataSchema).optional(),
});
```
Find the existing zod schema for `SoftwareDataStoreFieldSchema` with `grep -n "FieldSchema" src/authoring.ts src/software-map-model.ts | head`; if none exists, define a recursive one there (`z.record(z.string(), z.union([leaf, z.lazy(() => fieldSchema)]))`).

- [ ] **Step 4: Implement `review-document-data.ts`**

```ts
import type { JsonValue } from "@dev.fast/review-protocol";
import { z } from "zod";

import { type AnchorRef, anchorRefSchema, reviewAuthoringPropsSchemas, storeRefDataSchema } from "./authoring";
import { type SoftwareModelData, softwareModelDataSchema } from "./software-map-model";

export const REVIEW_DOCUMENT_FORMAT = "review-document/1";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export type ReviewAuthoringComponentName = keyof typeof reviewAuthoringPropsSchemas;
const componentNames = Object.keys(reviewAuthoringPropsSchemas) as [ReviewAuthoringComponentName, ...ReviewAuthoringComponentName[]];

export const PROSE_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "strong", "em", "del", "code", "pre", "blockquote", "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "input", "img"] as const;
const PROSE_PROPS = new Set(["className", "href", "title", "id", "align", "checked", "disabled", "start", "type", "alt", "src"]);
const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;

export type ReviewElementProps = Record<string, string | number | boolean>;
export interface ReviewTextNode { type: "text"; value: string }
export interface ReviewElementNode { type: "element"; tag: string; props: ReviewElementProps; children: ReviewNode[] }
export interface ReviewComponentNode { type: "component"; name: ReviewAuthoringComponentName; props: Record<string, JsonValue>; children: ReviewNode[] }
export type ReviewNode = ReviewTextNode | ReviewElementNode | ReviewComponentNode;

const elementPropsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).superRefine((props, context) => {
  for (const [key, value] of Object.entries(props)) {
    if (!PROSE_PROPS.has(key) && !key.startsWith("data-review-")) context.addIssue({ code: "custom", message: `prop "${key}" is not allowed in review prose` });
    if ((key === "href" || key === "src") && !(typeof value === "string" && SAFE_URL.test(value))) context.addIssue({ code: "custom", message: `${key} "${String(value)}" uses a disallowed protocol` });
  }
});

const componentPropsSchema = (name: ReviewAuthoringComponentName): z.ZodType<Record<string, JsonValue>> =>
  name === "DatabaseLens"
    ? z.object({ stores: z.record(z.string(), storeRefDataSchema) }).catchall(jsonValueSchema) as z.ZodType<Record<string, JsonValue>>
    : z.record(z.string(), jsonValueSchema);

export const reviewNodeSchema: z.ZodType<ReviewNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), value: z.string() }),
    z.strictObject({ type: z.literal("element"), tag: z.enum(PROSE_TAGS), props: elementPropsSchema, children: z.array(reviewNodeSchema) }),
    z.strictObject({ type: z.literal("component"), name: z.enum(componentNames), props: z.record(z.string(), jsonValueSchema), children: z.array(reviewNodeSchema) })
      .superRefine((node, context) => {
        const result = componentPropsSchema(node.name).safeParse(node.props);
        for (const issue of result.success ? [] : result.error.issues) context.addIssue({ code: "custom", path: ["props", ...issue.path], message: issue.message });
      }),
  ]),
);

export interface ReviewDocumentData { format: typeof REVIEW_DOCUMENT_FORMAT; title: string; routePath: string; sourcePath: string; body: ReviewNode[]; anchors: Record<string, AnchorRef>; anchorContents: Record<string, string>; softwareModels: SoftwareModelData[] }

export const reviewDocumentDataSchema: z.ZodType<ReviewDocumentData> = z.strictObject({
  format: z.literal(REVIEW_DOCUMENT_FORMAT), title: z.string(), routePath: z.string(), sourcePath: z.string(),
  body: z.array(reviewNodeSchema), anchors: z.record(z.string(), anchorRefSchema), anchorContents: z.record(z.string(), z.string()), softwareModels: z.array(softwareModelDataSchema),
});

export function stripPeekResolutions<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, current: unknown) =>
    current && typeof current === "object" && (current as { __kind?: unknown }).__kind === "code-peek-ref" ? { ...(current as object), resolution: null } : current)) as T;
}

export function walkReviewNodes(nodes: ReviewNode[], visit: (node: ReviewNode, parent: ReviewComponentNode | null) => void, parent: ReviewComponentNode | null = null): void {
  for (const node of nodes) {
    visit(node, parent);
    if (node.type !== "text") walkReviewNodes(node.children, visit, node.type === "component" ? node : parent);
  }
}
```
`anchorRefSchema.peek.resolution` is `z.custom<CodePeekResolution>().nullable()`; because the document is JSON-round-tripped and resolutions are stripped, refine it at this boundary: wrap with `.refine((v) => v === null, "resolutions never ship")` on a local copy of the anchor schema if the base schema cannot change.

- [ ] **Step 5: Run both test files → PASS. Commit.**

```bash
rm -rf packages/progressive-review/spike-review-data
git add packages/progressive-review/src/review-document-data.ts packages/progressive-review/src/review-document-data.test.ts packages/progressive-review/src/authoring.ts packages/progressive-review/src/authoring.test.ts
git commit -m "Add the review document data schema and store-handle data"
```

### Task B2: Materialize the publish element tree into document data

**Files:**
- Create: `packages/progressive-review/src/review-document-materialize.ts`
- Modify: `packages/progressive-review/src/review-publish-element-audit.ts` — export `flattenChildren`, `isAuditElement`, `FRAGMENT`, `AuthoringComponentName`; `auditReviewDocumentComponent` returns `{ tree: PublishAuditNode; componentNames: ReadonlyMap<PublishAuditElementType, AuthoringComponentName> } | null`.
- Modify: `packages/progressive-review/src/review-publish-evaluate.ts` — `createActiveReviewDocument` stub captures `{ title, routePath, filePath, models }` plus the audit's tree; after import, build `ReviewDocumentData`; result gains `document`.
- Test: `packages/progressive-review/src/review-document-materialize.test.ts`; extend `review-publish-evaluate.test.ts`.

**Interfaces:**
```ts
// review-document-materialize.ts
export interface MaterializedReviewDocument { body: ReviewNode[]; errors: string[] }
export function materializeReviewDocument(input: { tree: PublishAuditNode; componentNames: ReadonlyMap<PublishAuditElementType, AuthoringComponentName> }): MaterializedReviewDocument
export function collectReviewAnchors(models: Record<string, unknown>): { anchors: Record<string, AnchorRef>; anchorContents: Record<string, string> }   // port of app/src/review-documents-runtime.ts:89-127; throws on duplicate ids
// review-publish-evaluate.ts
export interface ReviewPublishEvaluationResult { document: ReviewDocumentData | null; peekCount: number; rangePeeks: ReviewPublishRangePeek[]; errors: string[]; warnings: string[] }
```
Materialization rules: string/number → text; array → flattened; `FRAGMENT` → flattened children; string tag → element (props minus `children`/`key`; every value must be string/number/boolean; else error); registry stub → `schema.parse(props)` then `normalizeComponentProps(name, parsed)` (drop `children`; `DatabaseLens.stores` → `mapValues(storeRefData)`); any other function type → error `Document-local components are not supported; use the Review components.`; other symbols → error.

**Success criteria:**
- `materializeReviewDocument` converts prose, fragments, nested registry components, and `DatabaseLens` stores into nodes that survive `JSON.parse(JSON.stringify(...))` unchanged; document-local components and non-literal prose props are reported as errors.
- `evaluateReviewDocumentBundleForPublish` returns `document !== null` with `errors: []` for a valid bundle, and `document: null` plus at least one error for any audit, peek, evidence, or schema failure. Every `peek.resolution` in `document` is `null`.
- `document.title`, `routePath`, `sourcePath` come from the bundle's `createActiveReviewDocument` input; `document.anchors` has one entry per authored anchor id; `document.softwareModels` has one entry per `defineSoftwareModel` export.

**End-to-end check:** add `packages/progressive-review/src/tutorial-document-data.test.ts` (node env; requires `build:tutorial-assets` to have produced `tutorial/git-stub`): compile the tutorial with `compileReviewDocumentBundle`, evaluate it with `prepareEvidence` pointing at the stub repo (exactly as `scripts/build-tutorial-assets.ts:215-222` does), and assert `errors` is empty, `document` is non-null, the set of component names in `document.body` equals `{ReviewSection, AnchorLink, CodePeek, SequenceDiagram, DatabaseLens, DbUseCase, DbWrite, TutorialKeymapPicker, TutorialAuthoringConversation, TutorialViewButton, TutorialFeature}`, `JSON.stringify(document)` contains no `"resolution":{`, and `reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(document)))` equals `document`.

- [ ] **Step 1: Failing materialize test** — build records with the real stub React (`createPublishValidationReact().jsx`) and a `componentNames` map made the way the audit does:

```ts
import { describe, expect, it } from "vitest";

import { createReviewDefinitionSession, reviewAuthoringPropsSchemas } from "./authoring";
import { materializeReviewDocument } from "./review-document-materialize";
import { type PublishAuditComponent, FRAGMENT, createPublishValidationReact } from "./review-publish-element-audit";

const react = createPublishValidationReact();
const componentNames = new Map<PublishAuditComponent | string | symbol, keyof typeof reviewAuthoringPropsSchemas>();
const stubs = Object.fromEntries(Object.keys(reviewAuthoringPropsSchemas).map((name) => { const stub = () => null; componentNames.set(stub, name as never); return [name, stub]; }));
const anchor = { __kind: "db-anchor-ref", id: "a", title: "A", peek: { __kind: "code-peek-ref", props: { file: "x.ts", fromLine: 1, toLine: 2 }, resolution: null } };

describe("materializeReviewDocument", () => {
  it("turns prose, fragments, and registry elements into nodes", () => {
    const tree = react.jsx(FRAGMENT, { children: [
      react.jsx("h1", { "data-review-block-index": 0, "data-review-block-tag": "h1", children: "Title" }),
      react.jsx(stubs.ReviewSection, { title: "Part", children: [
        react.jsx("h2", { "data-review-block-index": 1, "data-review-block-tag": "h2", children: "Part" }),
        react.jsx(stubs.CodePeek, { anchor }),
      ] }),
    ] });
    const { body, errors } = materializeReviewDocument({ tree, componentNames });
    expect(errors).toEqual([]);
    expect(body[0]).toEqual({ type: "element", tag: "h1", props: { "data-review-block-index": 0, "data-review-block-tag": "h1" }, children: [{ type: "text", value: "Title" }] });
    expect(body[1]).toMatchObject({ type: "component", name: "ReviewSection", props: { title: "Part" } });
    expect((body[1] as { children: unknown[] }).children[1]).toEqual({ type: "component", name: "CodePeek", props: { anchor }, children: [] });
  });
  it("normalizes DatabaseLens stores to data", () => {
    const session = createReviewDefinitionSession({ softwareMap: null, baseSoftwareMap: null });
    const stores = session.defineStores({ db: { kind: "relational", label: "DB", tables: { orders: { label: "orders", schema: { status: { type: "text" } } } } } });
    const tree = react.jsx(stubs.DatabaseLens, { stores, children: react.jsx(stubs.DbUseCase, { id: "u", label: "U", children: react.jsx(stubs.DbWrite, { from: { __kind: "db-actor-ref", id: "svc", label: "S" }, to: stores.db.tables.orders.status, label: "w" }) }) });
    const { body, errors } = materializeReviewDocument({ tree, componentNames });
    expect(errors).toEqual([]);
    const lens = body[0] as { props: { stores: { db: { tables: { orders: { schema: unknown; target: { collectionId: string } } } } } } };
    expect(lens.props.stores.db.tables.orders.schema).toEqual({ status: { type: "text" } });
    expect(lens.props.stores.db.tables.orders.target.collectionId).toBe("orders");
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });
  it("rejects document-local components and non-literal prose props", () => {
    const local = () => null;
    expect(materializeReviewDocument({ tree: react.jsx(local, {}), componentNames }).errors[0]).toMatch(/Document-local components/);
    expect(materializeReviewDocument({ tree: react.jsx("p", { style: { color: "red" } }), componentNames }).errors[0]).toMatch(/style/);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `review-document-materialize.ts`**

```ts
import { type AnchorRef, type StoreRef, reviewAuthoringPropsSchemas, storeRefData } from "./authoring";
import { type ReviewAuthoringComponentName, type ReviewComponentNode, type ReviewElementProps, type ReviewNode } from "./review-document-data";
import { type AuthoringComponentName, FRAGMENT, type PublishAuditElementType, type PublishAuditNode, flattenChildren, isAuditElement } from "./review-publish-element-audit";

export interface MaterializedReviewDocument { body: ReviewNode[]; errors: string[] }

// The validation runtime already produced every element the document
// creates. This turns those records into the JSON document: prose elements
// keep the React-named props the MDX compiler emitted; registry components
// carry their zod-parsed props normalized to data (D5).
export function materializeReviewDocument(input: { tree: PublishAuditNode; componentNames: ReadonlyMap<PublishAuditElementType, AuthoringComponentName> }): MaterializedReviewDocument {
  const errors: string[] = [];
  const body = materializeChildren(input.tree, input.componentNames, errors);
  return { body, errors };
}

function materializeChildren(node: PublishAuditNode, names: ReadonlyMap<PublishAuditElementType, AuthoringComponentName>, errors: string[]): ReviewNode[] {
  const out: ReviewNode[] = [];
  for (const child of flattenChildren(node)) {
    if (typeof child === "string" || typeof child === "number") { out.push({ type: "text", value: String(child) }); continue; }
    if (!isAuditElement(child)) continue;
    if (child.type === FRAGMENT) { out.push(...materializeChildren(child.props.children, names, errors)); continue; }
    const { children, key: _key, ...props } = child.props;
    if (typeof child.type === "string") {
      const elementProps: ReviewElementProps = {};
      for (const [name, value] of Object.entries(props)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") elementProps[name] = value;
        else errors.push(`<${child.type}> prop "${name}" must be a string, number, or boolean.`);
      }
      out.push({ type: "element", tag: child.type, props: elementProps, children: materializeChildren(children, names, errors) });
      continue;
    }
    const name = names.get(child.type);
    if (!name) {
      errors.push(typeof child.type === "function" ? "Document-local components are not supported; use the Review components." : `Unsupported element type ${String(child.type)}.`);
      continue;
    }
    const parsed = reviewAuthoringPropsSchemas[name].safeParse(child.props);
    if (!parsed.success) continue; // the audit already reported the issue
    const { children: _children, ...parsedProps } = parsed.data as Record<string, unknown>;
    out.push({ type: "component", name: name as ReviewAuthoringComponentName, props: normalizeComponentProps(name, parsedProps), children: materializeChildren(children, names, errors) } as ReviewComponentNode);
  }
  return out;
}

function normalizeComponentProps(name: AuthoringComponentName, props: Record<string, unknown>): ReviewComponentNode["props"] {
  if (name === "DatabaseLens") {
    const stores = props.stores as Record<string, StoreRef>;
    return { ...props, stores: Object.fromEntries(Object.entries(stores).map(([id, store]) => [id, storeRefData(store)])) } as ReviewComponentNode["props"];
  }
  return props as ReviewComponentNode["props"];
}

export function collectReviewAnchors(models: Record<string, unknown>): { anchors: Record<string, AnchorRef>; anchorContents: Record<string, string> } {
  /* verbatim port of app/src/review-documents-runtime.ts:89-127 with Maps → records */
}
```
Port `collectReviewAnchors` literally (the `visited` set, the sequence-ref and anchor-ref branches, the two duplicate errors).

- [ ] **Step 4: Wire the evaluator** — in `review-publish-evaluate.ts`:
  - `auditReviewDocumentComponent` returns `{ tree, componentNames }` (or `null` when the document did not evaluate).
  - The stub `createActiveReviewDocument` (`:436`) captures `documentInput = { title, routePath, filePath, models }` and `audit = auditReviewDocumentComponent(...)`.
  - After the import and the existing evidence checks, when `failures.length === 0 && audit && documentInput`:
    ```ts
    const materialized = materializeReviewDocument(audit);
    failures.push(...materialized.errors);
    let anchors: ReturnType<typeof collectReviewAnchors> | null = null;
    try { anchors = collectReviewAnchors(documentInput.models); } catch (error) { failures.push(errorMessage(error)); }
    const softwareModels = Object.values(documentInput.models).filter(isNormalizedSoftwareModel).map(softwareModelData);
    if (failures.length === 0 && anchors) {
      const candidate = stripPeekResolutions({ format: REVIEW_DOCUMENT_FORMAT, title: documentInput.title, routePath: documentInput.routePath, sourcePath: path.basename(documentInput.filePath), body: materialized.body, anchors: anchors.anchors, anchorContents: anchors.anchorContents, softwareModels });
      const parsed = reviewDocumentDataSchema.safeParse(JSON.parse(JSON.stringify(candidate)));
      if (parsed.success) document = parsed.data;
      else failures.push(...parsed.error.issues.map((issue) => `Review document data: ${issue.path.join(".")}: ${issue.message}`));
    }
    ```
  - Return `{ document, peekCount, rangePeeks, errors, warnings }`.

- [ ] **Step 5: Extend `review-publish-evaluate.test.ts`** — the existing `bundleWithAnchors` fixture calls `createActiveReviewDocument({ Component: () => null })`; add a fixture whose `Component` returns `jsx("h1", {...})` and a `CodePeek` stub element (the bundle receives `components` via props: `({ components }) => jsx(components.CodePeek, { anchor: anchors.request })`) and assert `result.document?.body` has the `h1` and `CodePeek` nodes, `document.anchors.request.peek.resolution === null`, and `document.title` equals the passed title.

- [ ] **Step 6: Run** — `pnpm vitest run --config vitest.config.ts src/review-document-materialize.test.ts src/review-publish-evaluate.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/progressive-review/src/review-document-materialize.ts packages/progressive-review/src/review-document-materialize.test.ts packages/progressive-review/src/review-publish-element-audit.ts packages/progressive-review/src/review-publish-evaluate.ts packages/progressive-review/src/review-publish-evaluate.test.ts
git commit -m "Materialize the review document data from the publish validation tree"
```

### Task B3: Seal and write the JSON artifact

**Files:**
- Modify: `packages/progressive-review/src/review-bundle.ts`
- Modify: `packages/progressive-review/src/review-publication-preparation.ts:86-117`
- Modify: `packages/progressive-review/scripts/build-tutorial-assets.ts:215-270`, `scripts/check-tutorial.ts:83-92`, `tutorial/runtime-manifest.json:11`, `apps/review-desktop/scripts/run.sh:81`, `apps/review-desktop/scripts/packaged-runtime.test.mjs:241`
- Test: `packages/progressive-review/src/review-bundle.test.ts` (new)

**Interfaces:**
```ts
export interface ReviewDocumentBundle { document: ReviewDocumentData; json: string; contentHash: string; routePath: string; sourcePath: string }
export function bundleReviewDocument(document: ReviewDocumentData): ReviewDocumentBundle       // json = JSON.stringify(document) + "\n"; contentHash = sha256(json).slice(0, 20)
export async function writeReviewDocumentBundle(reviewDir: string, bundle: ReviewDocumentBundle): Promise<void>   // review-document.json + manifest {version: 2, routePath, sourcePath}; removes any review-document.js
export async function readReviewDocumentBundle(documentDir: string, routePath: string): Promise<ReviewDocumentBundle | null>   // null for ENOENT, version !== 2, routePath mismatch, or a JSON that fails reviewDocumentDataSchema
```
`compileReviewDocumentBundle`'s `ReviewDocumentBundle` type in `doc-bundler.ts` is renamed `CompiledReviewDocument` (`code`, `contentHash`, `routePath`, `sourcePath`) to free the name.

**Success criteria:**
- `readReviewDocumentBundle(await write(bundle))` deep-equals `bundle` and `contentHash` is identical across write and read; a version-1 manifest with `review-document.js` reads as `null`; writing removes any stray `review-document.js`.
- `pnpm --filter @dev.fast/review check:tutorial` passes with the JSON assertions; `packaged-runtime.test.mjs` passes with the `.json` name.
- Note: `session-handler.ts` must compile after this task. Change its `new Response(bundle.code, …)` to `bundle.json` here (route names change in B4).

**End-to-end check:** `pnpm --filter @dev.fast/review build:tutorial-assets` then `jq -r .format packages/progressive-review/tutorial/.bundle/document/review-document.json` prints `review-document/1` and `ls …/document` lists exactly `manifest.json review-document.json`. Then, with the app runtime, `review scaffold` + author the two-line sample from `document-authoring.md` + `review publish --review <uuid> --json` on a real repo: the command reports `published`, and `~/.dev/reviews/<uuid>/.bundle/document/` contains `review-document.json` and no `.js`. (The running app cannot render it until B6; that is expected here.)

- [ ] **Step 1: Failing test** — write/read round trip with a minimal `ReviewDocumentData`; a version-1 manifest + `review-document.js` reads as `null`; `contentHash` is stable across write/read.
- [ ] **Step 2: Implement** as in Interfaces (mirror A1's structure; `parseJsonText` + `reviewDocumentDataSchema.safeParse`).
- [ ] **Step 3: Callers** — `review-publication-preparation.ts`: after evaluation, `if (!evaluation.document) throw new ReviewPublicationValidationError(evaluation.errors.length ? evaluation.errors : ["Review document did not materialize."], undefined, warnings)`; `await writeReviewDocumentBundle(input.review.dir, bundleReviewDocument(evaluation.document))`. `build-tutorial-assets.ts:269`: `writeReviewDocumentBundle(outDir, bundleReviewDocument(evaluation.document!))` after the existing checks. `check-tutorial.ts`: manifest `version !== 2`; parse `review-document.json` and assert `format`. `runtime-manifest.json`, `run.sh`, `packaged-runtime.test.mjs`: `.json`.
- [ ] **Step 4: Run** — `pnpm --filter @dev.fast/review test && pnpm --filter @dev.fast/review build:tutorial-assets && pnpm --filter @dev.fast/review check:tutorial`.
- [ ] **Step 5: Commit** — `git add -A packages/progressive-review apps/review-desktop/scripts && git commit -m "Seal the review document as JSON"`.

### Task B4: Server route and republish signal; protocol load states

**Files:**
- Modify: `packages/review-protocol/src/contracts.ts` — `ReviewErrorResponseSchema` gains `code: requiredString.optional(), reviewUuid: z.uuid().optional(), mapStale: z.boolean().optional()`; `ReviewDocModuleResponseSchema` → `ReviewDocumentResponseSchema { ok: true, contentHash, documentUrl }`; add the load-state types and use them in the session content:
  ```ts
  export type ReviewDocumentLoad =
    | { state: "ready"; contentHash: string; data: unknown }
    | { state: "needs-republish"; reviewUuid: string; mapStale: boolean }
    | { state: "unavailable"; message: string };
  export type ReviewSoftwareMapLoad =
    | { state: "ready"; contentHash: string; head: unknown; base: unknown }
    | { state: "needs-republish"; reviewUuid: string }
    | { state: "unavailable"; message: string };
  // kind: "session": document: Promise<ReviewDocumentLoad>; softwareMap: Promise<ReviewSoftwareMapLoad | null>;
  ```
- Modify: `packages/review-protocol/src/index.ts:164-175` (delete `rewriteReviewDocumentRuntime`), `index.test.ts:325-340`.
- Modify: `packages/progressive-review/src/server/session-handler.ts:41, 160-176, 192-193, 264-289` (+ `/software-map` returns `409 needs_republish` when the map bundle read is null but a map root exists).
- Test: `session-handler.test.ts` — `/document` happy path; `409 needs_republish` with `reviewUuid` and `mapStale`.

**Success criteria:**
- `GET /__progressive-review/document` returns `{ ok: true, contentHash, documentUrl }` ending in `.json`; `GET /__progressive-review/documents/<hash>.json` returns the sealed JSON as `application/json; charset=utf-8`, `cache-control: no-store`; other names 404.
- A version-1 or missing document bundle answers `409 { ok: false, code: "needs_republish", error, reviewUuid, mapStale }`, with `mapStale: true` exactly when a map root exists but its bundle reads as `null`.
- `pnpm --filter @dev.fast/review-protocol test` passes; `rewriteReviewDocumentRuntime` is gone from `review-protocol` and its overlay; `ReviewCanvasContent`'s session member is typed with `ReviewDocumentLoad` / `ReviewSoftwareMapLoad`.

**End-to-end check:** covered by the handler tests over the real Hono app. Live check lands in B6 once the host and app consume the new route.

- [ ] **Step 1: Failing tests** (as in draft 1, Task B5 Step 1, with `/document` and `documentUrl`).
- [ ] **Step 2: Implement** — routes exactly as draft 1 Task B5 Step 2 (`DOCUMENT_PATH_PREFIX = "/documents/"`, `getBundle(): Promise<ReviewDocumentBundle | null>`, 409 payload `{ ok: false, code: "needs_republish", error: "This review was published by an earlier version of Review and its document must be regenerated.", reviewUuid, mapStale }`). Audit other `getBundle()` users for `null`.
- [ ] **Step 3: Run** — protocol tests, session-handler tests → PASS. Commit `"Serve the review document as JSON and signal republish"`.

### Task B5: Host loads JSON into load states; runtime chunk removed

**Files:**
- Modify: `reviewSessionModelService.ts:49-58, 279-325` — loaders return `ReviewDocumentLoad` / `ReviewSoftwareMapLoad`; a 409 `needs_republish` becomes `{ state: "needs-republish", ... }`; any other failure becomes `{ state: "unavailable", message }` (no throw).
- Rename `reviewDocumentModule.ts` → `reviewDocumentData.ts`: `loadReviewDocumentData(session, documentUrl, contentHash): Promise<ReviewDocumentLoad>` via `fetchReviewJson`; `loadReviewSoftwareMaps(...)` returns the ready state. Delete the Trusted Types policy, `ReviewModuleCache` uses, `importBlobReviewModule`.
- Modify: `reviewCanvasPart.ts:132-137, 1209-1226, 1445-1462, 1498-1512`; `apps/review-desktop/scripts/copy-canvas.mjs:42, 78-92` (+ `packaged-runtime.test.mjs:100-125`); `app/desktop.vite.config.ts:62-66`; delete `app/src/doc-runtime.ts`; `ReviewRuntimeConfig.docRuntimeUrl` removed; `app/src/review-session-test-utils.tsx:26`; `app/src/host/review-client.ts` (drop `importReviewModule`, `loadReviewModule`, `importBlobReviewModule`, `docRuntimeUrl` from the config pick) and its two import tests.

**Success criteria:**
- `pnpm --filter @dev.fast/review-desktop test` passes; `loadReviewSessionDocument` resolves to `{ state: "ready", contentHash, data }` for a 200, `{ state: "needs-republish", reviewUuid, mapStale }` for the 409, `{ state: "unavailable", message }` for any other failure, and never rejects (add three cases to the host's Node test runner next to `reviewModuleCache.test.ts`, stubbing `fetch`).
- The Vite manifest has no `doc-runtime` entry (`grep doc-runtime packages/progressive-review/app/dist/.vite/manifest.json` after `app:desktop:build` is empty); `canvas-loader.js` no longer exports `reviewDocRuntimeUrl`; `ReviewRuntimeConfig` has no `docRuntimeUrl`.
- `grep -rn "createObjectURL\|createScriptURL" apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewDocumentData.ts` is empty.

**End-to-end check:** none on its own; the canvas cannot consume the load states until B6. Do not open the app between B5 and B6 expecting a rendered review.

- [ ] **Step 1: Implement** as listed; `protocol:sync`.
- [ ] **Step 2: Verify** — `pnpm --filter @dev.fast/review-desktop test && pnpm --filter @dev.fast/review typecheck`; `grep -rn "doc-runtime\|reviewDocRuntimeUrl\|docRuntimeUrl\|review-doc-runtime" packages apps --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh' -l` → only `src/review-publish-evaluate.ts` (the validation runtime keeps the specifier by design) and `src/stored-review-migration.ts`.
- [ ] **Step 3: Commit** — `"Load the review document as data in the desktop host"`.

### Task B6: App hydrates, resolves peeks before mount, and renders the tree

**Files:**
- Create: `packages/progressive-review/app/src/review-document-hydrate.ts`
- Create: `packages/progressive-review/app/src/review-document-renderer.tsx`
- Modify: `app/src/review-documents-runtime.ts`, `app/src/review-document-surface.tsx`, `app/src/App.tsx:237, 243-244, 290, 644-648`, `app/src/desktop-entry.tsx:34-36, 73-112`, `app/src/review-definition-runtime.ts` (export `resolveCodePeekRequest`; delete `createBrowserReviewDefinitionSession`, `setReviewRequestContext`, `ReviewRequestContext`).
- Test: `app/src/review-document-hydrate.test.ts`, `app/src/review-document-renderer.test.tsx`; adjust `review-documents-runtime.test.ts`, `authoring-contract.test.tsx:200-208`, `App.test.ts`, `review-panel.test.tsx` fixtures.

**Interfaces:**
```ts
// review-document-hydrate.ts
export interface HydratedReviewDocument { contentHash: string; data: ReviewDocumentData; body: ReviewNode[]; anchors: ReadonlyMap<string, AnchorRef>; anchorContents: ReadonlyMap<string, string>; documentSoftwareModels: NormalizedSoftwareModel[]; title: string; routePath: string; filePath: string }
export function hydrateReviewDocument(load: Extract<ReviewDocumentLoad, { state: "ready" }>): HydratedReviewDocument
//   1. reviewDocumentDataSchema.parse(load.data)
//   2. canonicalize: every {__kind:"db-anchor-ref"} object inside body props is replaced by anchors[id] (error if missing) so identity is shared
//   3. DatabaseLens props.stores → hydrateStoreRef; softwareModels → hydrateSoftwareModel
export async function resolveReviewDocumentPeeks(document: HydratedReviewDocument, session: ReviewSession): Promise<void>
//   for every anchor with peek && !peek.resolution: resolveCodePeekRequest(routePath, peek.props, …) under runWithCodePeekResolutionSlot; assign peek.resolution; reject on the first failure
// review-document-renderer.tsx
export function renderReviewNodes(nodes: ReviewNode[], components: ReviewDocumentComponents): ReactNode
// review-documents-runtime.ts
export type ReadyReviewDocumentEntry = HydratedReviewDocument   // App reads contentHash, body, anchors, anchorContents, documentSoftwareModels, routePath, filePath
```

**Success criteria:**
- Hydration: an anchor inlined in a component prop is the *same object* as `anchors[id]` after hydration; `DatabaseLens` stores pass `collectionSchema`; software models carry a `Map`; `resolveReviewDocumentPeeks` issues exactly one request per unique peek and sets `peek.resolution` on the shared object; a failing peek rejects and the entry reports `unavailable`.
- Renderer: element props render verbatim; `pre > code.language-x` reaches `MarkdownCodeBlock`; a `ReviewSection` hoists the `h2`; `DatabaseLens` finds `DbUseCase` children by identity.
- `pnpm --filter @dev.fast/review test` and `typecheck` pass; `grep -rn "createBrowserReviewDefinitionSession\|setReviewRequestContext\|mdx/types" packages/progressive-review/app/src` is empty.

**End-to-end check (the main one):** run the desktop app from this worktree and open the tutorial (rebuilt by B3). Verify, in order: the document renders with section collapse working; hovering a typed symbol in the first code peek shows hover info and F12 jumps to the definition; leaving a comment on a prose paragraph creates a thread and clicking it in the Threads panel scrolls to it; the sequence diagram **Tour** walks messages and opens code evidence; the database lens opens the "Create an order" use case and highlights `orders.status`; the **Map** tab renders; the workbench devtools console shows no errors and the network log shows one `/__progressive-review/documents/<hash>.json` request plus one `/code-peek/resolve` per unique anchor. Then open a second review published with this build and repeat the peek and thread checks.

- [ ] **Step 1: Failing hydrate test** — a `ReviewDocumentData` literal with one anchor inlined twice (in `anchors` and in a `CodePeek` prop): after hydration the prop's anchor `===` the map entry; a DatabaseLens node's `stores.db.tables.orders` passes `collectionSchema(...)`; `documentSoftwareModels[0].elementsByPath` is a `Map`. Peek resolution test: stub `resolveCodePeekRequest` via `vi.mock("./review-definition-runtime")`, assert one request per anchor and `peek.resolution` set on the shared object.
- [ ] **Step 2: Failing renderer test** — as draft 1 Task B7 Step 1 (element props, `pre>code` → `MarkdownCodeBlock`, `ReviewSection` heading hoist, `DatabaseLens` children found by identity).
- [ ] **Step 3: Implement the renderer**

```tsx
import { type ComponentType, Fragment, type ReactNode, createElement } from "react";
import type { ReviewNode } from "../../src/review-document-data";
import type { reviewAuthoringComponents } from "./review-authoring-components";

export type ReviewDocumentComponents = typeof reviewAuthoringComponents & Record<string, ComponentType<never> | undefined>;

// The document is data: HTML elements, text, and registry components.
// Elements with an override (a, pre, h1) render through it; components render
// with the registry function itself so parents that inspect children by type
// (DatabaseLens, ReviewSection) keep working. Children are passed as varargs,
// so React needs no keys.
export function renderReviewNodes(nodes: ReviewNode[], components: ReviewDocumentComponents): ReactNode {
  return createElement(Fragment, null, ...nodes.map((node) => renderNode(node, components)));
}

function renderNode(node: ReviewNode, components: ReviewDocumentComponents): ReactNode {
  if (node.type === "text") return node.value;
  const children = node.children.map((child) => renderNode(child, components));
  if (node.type === "component") {
    return createElement(components[node.name] as ComponentType<Record<string, unknown>>, node.props, ...children);
  }
  const override = components[node.tag] as ComponentType<Record<string, unknown>> | undefined;
  return createElement(override ?? node.tag, node.props, ...children);
}
```
- [ ] **Step 4: Implement hydration and pre-mount resolution** per Interfaces; settle the document and map promises independently (D10), never gate either artifact on the other promise. Document `ready` → hydrate → resolve every unique peek → mount; other states replace only the document surface. Map `ready` → hydrate; other states affect only Map. Cache hydrated-document promises by artifact content hash within the session/route scope so offscreen validation and visible mounts share resolution without leaking pinned results across sessions. Bound the cache and evict rejected promises. This records the completed B6 adaptation, not a new task.
- [ ] **Step 5: App keying** — `detailRevision={document.contentHash}`, `documentRevision={document.contentHash}`; `ReviewDocumentContent({ body })` renders `renderReviewNodes(body, reviewDocumentComponents)`; `ReviewLayoutContent` prop `ReviewDocument: ReviewDocumentComponent` → `body: ReviewNode[]`.
- [ ] **Step 6: Run** — `pnpm --filter @dev.fast/review test` → green after fixture updates. Commit `"Render the review document from data"`.

### Task B7: Republish state

**Completed intermediate step:** commit `ea3552f2`. The following copy and
publish-based live check record that step. B8b replaces the recovery action and
copy with explicit repair; do not rerun B7 as new implementation. Live manifest
tests require a server restart if tab close/reopen reuses a cached bundle.

**Files:**
- Create: `app/src/republish-review.tsx` (+ `republish-review.test.tsx`, `// @vitest-environment jsdom`)
- Modify: `app/src/desktop-entry.tsx` (render `<RepublishReview>` for the needs-republish state and call `session.signalReady()`), `app/src/styles.css` (`.review-republish`, `.review-republish-command`, `.review-republish-actions` next to `.review-migration-warning`).

**Interfaces:**
```ts
export function republishReviewPrompt(input: { reviewUuid: string; mapStale: boolean }): string
export function RepublishReview(props: { reviewUuid: string; mapStale: boolean }): ReactElement
```
Prompt (exact):
> Republish the Review with id `<uuid>`. It was published by an earlier version of Review and its document must be regenerated. Run `review publish --review <uuid> --json`. If it reports validation errors, fix them in that Review's `review.mdx` or `data.ts` without changing what the review says, and rerun until it succeeds.
> *(mapStale)* Then run `review map publish --review <uuid> --json`.

**Success criteria:**
- `RepublishReview` renders the `h2` "Republish this review", the command in a `code` element, a button labelled "Copy command" that copies the command, and a primary button labelled "Copy prompt" that copies `republishReviewPrompt(...)`; the map line and the prompt's map sentence appear only when `mapStale` is true.
- With a `needs-republish` document load, `desktop-entry` renders the state instead of the loading screen, does not report an error diagnostic, and calls `session.signalReady()` (assert with the existing test utilities' fake session).

**End-to-end check:** open a review in the app, close it, edit the presented revision's materialized manifest (`~/.dev/reviews/<uuid>/.build/<presentedDocumentRevision>/.bundle/document/manifest.json`, set `"version": 1`), reopen: the republish state shows with the correct uuid; **Copy command** puts `review publish --review <uuid>` on the clipboard; **Copy prompt** puts the full prompt; Diff, Commits, and Threads tabs still work; running the copied command with the app runtime and reopening renders the document. Restore the manifest (or just republish) afterwards.

- [ ] **Step 1: Failing test** — as draft 1 Task B9 Step 1 (title `h2`, `code` with the command, buttons with `aria-label` "Copy command" then "Copy prompt", `copyText` called with the command and with the prompt, map line only when `mapStale`).
- [ ] **Step 2: Implement** — `section.review-republish > h2 + p + div.review-republish-command(code + CopyCommandButton) [+ map line] + div.review-republish-actions(CopyPromptButton)`; `CopyCommandButton` mirrors `CopyPromptButton` with `aria-label="Copy command"` and icon-only content.
- [ ] **Step 3: Run, commit** `"Show a republish state for pre-data review revisions"`.

### Task B8: Migration converts current sealed bundles

**Files:**
- Modify: `packages/review-protocol/src/contracts.ts:33-37` — `REVIEW_SCHEMA_VERSION = 5` with the comment "Version 5: document and software-map bundles are JSON".
- Modify: `packages/progressive-review/src/stored-review-migration.ts:383-437, 551-663`
- Modify: `src/review-home.ts` migration parser and `src/migrate.ts` post-migration reporting; keep strict current-record parsing outside the explicit legacy adapter added in B8a.
- Test: `stored-review-migration.test.ts`

**Success criteria:**
- `REVIEW_SCHEMA_VERSION === 5`; new records/writers use 5. Explicit legacy adapters must still accept 2/3/4, so a textual ban on every `4` is incorrect. Audit writers and compatibility branches separately.
- `stored-review-migration.test.ts`: a schema-4 review with a sealed version-1 document bundle migrates to schema 5, gains `review-document.json` with `format: "review-document/1"` and the expected nodes, changes `presentedDocumentRevision`, and leaves no `review-document.js`; a review whose sealed bundle fails validation is reported as a blocker and left untouched (backup restored).
- Schema-2 and schema-3 stores still migrate through the existing paths and end at schema 5.
- Convert only current presentation pointers, including accepted/rejected records. Resolve document and map from their own sealed revisions; stage both before promotion, seal the map first if necessary so the document's embedded record names the final map revision. Preserve already-valid v2 pointers, absent maps, status, pins, title, threads, dismissal and publication timestamps. Drafts without a presentation only upgrade their record.
- Failed conversion preserves record/authoring/candidate bytes and private refs, reports one actionable blocker, and never drops the review. Post-migration reporting must understand supported legacy failures rather than adding a misleading second schema error. Recovery visibility is completed by B8a/B8b, not by weakening rollback.
- Idempotent second run changes no presentation pointers. Older private commits remain untouched; a broken current map is a blocker, not silently treated as an absent map. An intact sealed document converts even if editable authoring sources are missing.
- These guarantees cover the entire `review migrate apply` command, including follow-on repository conversion, source audit and cleanup. A successful conversion must not subsequently reset presentation pointers, replace private history or delete threads; failed supported records must remain unchanged through those phases. Add a colocated-jj regression fixture; preserve its history or report an actionable blocker instead of resetting it.
- Use one cross-process mutation lock for migration and every competing candidate, seal, record and attribution writer, including CLI document/map publication. Server-only locking is insufficient. Do not hold a CLI lock while awaiting an HTTP operation that reacquires it; revalidate the prepared revision at promotion. Test a competing writer against both success and rollback so neither can erase the other's changes.

**End-to-end check:** on an isolated scratch store with isolated source repositories, run `review migrate apply` with the app runtime. It reports one conversion per changed review and no blockers for supported valid sealed artifacts (not merely intact sources). With only convertible fixtures, Home has no migration warning; spot-check two current presentations, including one map and one terminal review. In a separate mixed fixture, a failed conversion remains unchanged and the migration warning persists. Record rollback/idempotence evidence; B8a/B8b add recovery of that failure. Delete the validated scratch home/repositories afterwards.

- [ ] **Step 1: Failing test** — seed a schema-4 review with a sealed revision containing a version-1 document bundle whose `review-document.js` is a hand-written bundle in the `bundleWithAnchors` style (imports from `"review-doc-runtime"`, calls `createActiveReviewDocument({ title, routePath: "/", filePath: "review.mdx", modelNames: [], models: { anchors }, Component: ({ components }) => jsx("h1", { children: "T" }), isDefault: true })`); run `migrateStoredReviewData`; assert `schemaVersion === 5`, `review-document.json` exists with `format === "review-document/1"` and an `h1` node, `presentedDocumentRevision` changed, no `review-document.js` remains.
- [ ] **Step 2: Implement** — accept `schemaVersion === 4` in the migrate set and migration parser; rename `migrateLegacyPresentedArtifacts` → `regeneratePresentedArtifacts`; use the following only for legacy v1 document conversion (preserve v2 bundles and unpresented drafts):

```ts
  const legacyBundleCode = await readFile(path.join(legacyBuildDir, ".bundle", "document", "review-document.js"), "utf8")
    .catch(() => readFile(path.join(legacyBuildDir, ".bundle", "review-document.js"), "utf8"));   // schema-2 layout
  const evaluated = await evaluateReviewDocumentBundleForPublish({ bundleCode: legacyBundleCode, reviewDir: legacyBuildDir, validateRanges: false });
  if (!evaluated.document) throw new Error(evaluated.errors.join("; "));
  const documentBundle = bundleReviewDocument(evaluated.document);
```
Write into isolated staging first; `evaluated.warnings` → `input.log`. For schema 4 the legacy document revision is `presentedDocumentRevision`; map recovery reads `presentedSoftwareMapRevision`, not the document directory by assumption. Adapt A4's `legacySoftwareMapBundle` to distinguish absent maps from conversion errors. Commit all candidates/pointers under the review lock only after preparation succeeds; preserve rollback and lifecycle invariants above.
- [ ] **Step 3: Run, commit** `"Migrate stored reviews to JSON document artifacts"`.

### Task B8a: Expose recovery for current legacy presentations

**Files:** `src/review-home.ts`, `src/server/desktop-server.ts`, Home/recovery
transport contracts and host consumers, `app/src/review-home-view.tsx`, and tests.
Inspect existing descriptors before extending them; do not cast malformed
records to the current schema or write upgraded records while listing/opening.

**Success criteria:**
- A strictly validated schema-2/3/4 record that failed B8 remains an explicit
  migration blocker and also appears as an openable recovery entry in Home.
  Ordinary schema-5 records retain their current behavior. Unsupported/malformed
  records remain errors, not fabricated sessions.
- Opening current recovery normalizes supported metadata in memory, including
  embedded sealed records. It never imports legacy JS or modifies the store.
  It reports independent document/map states and retains Diff, Commits, Threads
  and valid artifacts. Missing underlying data gets specific unavailable states.
- A requested older revision with a pre-data bundle is unavailable with the
  exact message and Open current review action from spec §7, not a current
  repair command. Already-JSON historical versions remain readable, including
  those with a supported legacy embedded record. No private history is rewritten.
- Terminal status and all stored bytes/refs remain unchanged by listing/opening.

**End-to-end check:** open the mixed failed-migration scratch fixture from Home,
including a terminal case; verify recovery visibility alongside the warning,
correct UUID and intact independent views. Open an older pre-data revision and
verify its unavailable message and navigation to the current review. Compare
stored bytes/refs before and after these read-only actions.

- [ ] **Step 1: Red tests** for supported failure visibility, malformed-record
  rejection, current-vs-historical routing, independent views and read-only state.
  Run and confirm failures before implementation.
- [ ] **Step 2: Implement** the narrow legacy adapter and explicit recovery
  descriptors/open routing. Add the historical unavailable state without a dual
  executable loader. Show an explanatory recovery state without executable copy
  actions for legacy/terminal records until B8b implements repair; do not expose
  B7's ordinary publish command as a temporary terminal recovery workaround.
- [ ] **Step 3: Gates and live check** — Review tests/typecheck, desktop tests,
  protocol sync and the E2E above. Commit `"Expose current legacy review recovery"`.

### Task B8b: Repair current artifacts without lifecycle changes

**Files:** CLI registration/orchestration (new `review-repair.ts` if appropriate),
shared artifact preparation/validation, server repair endpoint/promotion and
locking, protocol/host consumers as needed, `republish-review.tsx` and map-only
recovery UI, tests. Preserve normal publish and map-publish terminal checks.

**Interface:** `review repair --review <uuid> [--json]`. Require explicit UUID;
no history revision selector and no implicit checkout selection. Return old/new
artifact revisions and preserved status, or structured diagnostics/no-op.

**Success criteria:**
- Follow spec §7 exactly: current presentation only; sealed conversion first;
  explicit editable-source fallback with full pinned-range/evidence validation;
  stale-map sealed conversion or validated saved notes at the same pins. An
  already-valid independent artifact is preserved, not needlessly regenerated.
- Do not silently overwrite source files or adopt unrelated unpublished edits.
  The command reports when source fallback is required/used and the prompt
  instructs the caller to reconcile those edits without changing the review's
  meaning. Validation is not represented as proof of semantic equivalence.
- Healthy current artifacts return a no-op; drafts without a presentation are
  directed to publish. Missing inputs or failed validation leave the old review
  unchanged with actionable diagnostics. Never turn a broken map into no map.
- A dedicated promotion path validates mount/readiness, acquires the review
  lock, checks original pointers/pins/status for concurrent changes, then updates
  only schema/artifact fields. Preserve status, pins, title, threads, dismissal,
  publication timestamps and old private revisions. Repair does not resolve or
  submit feedback, require closed comments, or reopen accepted/rejected reviews.
  Pending active agent writes must block repair rather than race authoring.
- Failure at preparation, mount, concurrency check or promotion rolls back
  candidate files/refs/record and retains the visible old presentation. Successful
  terminal repair remains terminal; ordinary publish/map publish still fail.
- Replace B7's final copy with spec §7: heading "Repair this review", one
  `review repair --review <uuid>` command, shared Copy command/Copy prompt,
  exact prompt and conditional stale-map sentence. A map-only failure exposes
  repair inside Map while a valid document remains usable. Expected recovery
  states signal ready without error diagnostics.

**End-to-end check:** use scratch current active, accepted and rejected reviews
with failed legacy conversion and repairable sources, plus a map-only failure.
Verify copy values and independent views; repair via the copied command and
reopen to see JSON. Compare status/pins/title/threads/dismissal/timestamps and
old history before/after. Confirm ordinary terminal publish still fails. Exercise
one validation failure and one concurrency rejection with unchanged pointers;
repeat successful repair for a no-op. A missing-source fixture must remain a
clear blocker, not falsely claim success. Restore/delete only scratch data.

- [ ] **Step 1: Red tests** for CLI selection, terminal preservation, copy text,
  map-only repair, source fallback, healthy no-op, drafts, missing inputs,
  rollback, mount failure and concurrent changes. Run and confirm failures.
- [ ] **Step 2: Implement** shared preparation plus dedicated repair promotion;
  wire CLI/UI without routing through normal lifecycle promotion. Extend B7's
  clipboard/state tests instead of keeping competing recovery commands.
- [ ] **Step 3: Gates and live check** — Review tests/typecheck, desktop tests,
  protocol sync, targeted lint/format and the E2E above. Commit
  `"Repair current review artifacts without reopening reviews"`.

### Task B9: Tutorial end-to-end, docs, gate

**Success criteria:**
- `tutorial-document.test.tsx` passes: the parsed tutorial JSON renders, every expected registry name is present, and `data-review-block-index` values are `0…n-1` in DOM order.
- Block-index parity: the ordered `(tag, index, text)` list from the pre-change `0ad9297b` MDX render equals the list from the new renderer for the tutorial (recorded in the PR description), not the current moving `main`.
- Docs updated as listed; the gate commands all pass.

**End-to-end check (Phase 2 gate):** rerun B6, B8, B8a and B8b on the *packaged*
app. B8b's repair UI replaces B7's obsolete publish-based recovery check.
Build with `SKIP_NOTARIZE=1 pnpm --filter @dev.fast/review-desktop app:package:macos`
for local macOS QA; `pnpm --filter @dev.fast/review app:desktop:build` builds only
the canvas and is not a packaged-app substitute. Publish a new review with the
packaged CLI (`scaffold` → author → `publish` → `map publish`) and open it.
Open the **current presentation of a terminal review** after migration/repair;
this does not mean repairing every historical revision. Separately verify that
older pre-data history is unavailable with Open current review and no repair
action. Current candidate document directories of successfully migrated/repaired
reviews contain only JSON; unchanged failed records and immutable old history
may retain JS and must be reported, not silently deleted. Run the full gate below.

- [ ] **Step 1: Tutorial data test** — `app/src/tutorial-document.test.tsx` (as draft 1 Task B8): parse `tutorial/.bundle/document/review-document.json`, render through `hydrateReviewDocument` (peeks stubbed) + `renderReviewNodes`, assert the registry names present and that `data-review-block-index` values are `0..n-1` in DOM order.
- [ ] **Step 2: Block-index parity** — use a clean sibling worktree at the recorded pre-change base `0ad9297b` (not a drifting `origin/main` that may already include these changes). Build the old tutorial assets, render the old MDX component with React DOM/jsdom, and compare ordered `(tag, index, text)` values against the JSON renderer. Record the exact base SHA and result in the PR description. Never stash or mutate the core checkout.
- [ ] **Step 3: Manual smoke** — perform the packaged-app E2E above, including failed-conversion recovery, exact clipboard strings, map-only failure, terminal preservation, old-history navigation and failure rollback. A deliberately stale materialized manifest can require a server restart to clear the immutable session bundle cache. Restore it afterward. Record the preexisting ResizeObserver caveat separately from new failures.
- [ ] **Step 4: Docs** — update `docs/how-review-works.md` and `packages/progressive-review/skills/dev-review/references/lifecycle-and-storage.md` for JSON, schema 5, migrate-versus-repair, current-only recovery, terminal preservation and unsupported pre-data history. Document CDN-cacheable JSON in `docs/how-review-works.md` and report the substitution for absent `goal/PLAN.md`. Keep compiler/dependency descriptions until Phase 3. Add only the document-local-component restriction to `packages/progressive-review/skills/dev-review/references/document-authoring.md`.
- [ ] **Step 5: Gate** — `pnpm --filter @dev.fast/review test && pnpm --filter @dev.fast/review typecheck && pnpm --filter @dev.fast/review-desktop test && pnpm lint && pnpm format:check && pnpm --filter @dev.fast/review check:tutorial`. Commit `"Document the JSON review artifact"`; open PR "Review document as data" against the Phase 1 branch `software-map-bundle-json` while PR1 is unmerged, or against `main` if PR1 has merged. Include all deviations and E2E evidence, the recovery scope amendment, and unresolved blockers. Do not merge without a separate request.

---

# Phase 3 — Remove the MDX compiler and esbuild (scope; separate plan)

Not executed under this plan. Write `docs/superpowers/plans/<date>-remove-mdx-compiler.md` when scheduled, after the plain-JSON authoring decision.

**What it removes:** `src/compiler/*` (MDX→JSX compile, TypeScript transpile, virtual TSX typecheck, syntax validator if unused elsewhere), `src/server/doc-bundler.ts`, the stub-React validation runtime in `src/review-publish-evaluate.ts` and `review-publish-element-audit.ts` (`createPublishValidationReact`), runtime deps `esbuild`, `@mdx-js/mdx`, `remark-mdx`, `remark-frontmatter`, `remark-gfm`, `source-map`, `es-module-lexer`.

**What replaces it (design proven by the 2026-09-04 spike, spec §3):** parse `review.mdx` to mdast with the existing `remarkReviewAnchorLinks`/`remarkReviewSections` plugins; import `data.ts` in place with Node 24 type stripping through a `module.registerHooks` resolve hook that maps `virtual:progressive-review-authoring` to a per-call shim and version-stamps every URL under the realpathed review dir; evaluate attribute expressions against the imported bindings named by the MDX import line; parse each component's props with its zod schema; convert to hast and normalize props with `property-information`; emit the **same `ReviewDocumentData`** Phase 2 emits, so the server, host, and app do not change.

**Preconditions and known costs:** new authoring constraints (erasable TypeScript in `data.ts`, JSON imports with `with { type: "json" }`, one import from `./data.ts`, no bare `{}` expressions, no JSX in attributes, no spread); `typescript` stays if `software-map-connectivity-validation.ts` still needs it; `review migrate apply` must keep a copy of the validation-runtime evaluator for one release to convert any remaining version-1 bundles, or drop support for them with a release note. The tutorial's `data.ts` already carries the JSON import attribute (done in this worktree).

**Acceptance criteria when planned:** the tutorial's `review-document.json` produced by the new builder is byte-identical (after stable-key JSON formatting) to the one Phase 2 produces from the compiler; `esbuild`, `@mdx-js/mdx`, `remark-*`, `source-map`, `es-module-lexer` are absent from `dependencies`; a publish-error test matrix covers every new authoring constraint with the `review.mdx:<line>` position; `review migrate apply` still converts a version-1 bundle or the release notes state that support ended.

**Deliverables when planned:** loader module (`review-data-module.ts`), tree builder (`review-document-tree.ts`), build orchestration replacing `evaluateReviewDocumentBundleForPublish`, publish-error test matrix, dependency removal, docs.

## Self-review (recovery revision)

- Spec coverage: D1 → B1–B6; D2/D12 → A4, B8/B8a/B8b; D3 → B2; D4 → Phase 3; D5 → B1, B2; D6 → B2 Step 4; D7 → B1; D8 → A1–A4; D9 → B6; D10 → B4/B5/B8a/B8b; D11 → B6 Step 5; §7 initial UI → B7 and final repair → B8b; §8 docs → B9; §9 tests → each task plus B9.
- Placeholders: `collectReviewAnchors` and the schema-2 `legacyRevision` field are marked as literal ports of code quoted in this plan's "Verified facts"; no TBDs.
- Type consistency: `ReviewDocumentBundle` (JSON) vs `CompiledReviewDocument` (esbuild output) are distinct names from B3 on; `ReviewDocumentLoad`/`ReviewSoftwareMapLoad` are defined once in B4 and consumed in B5/B6; `HydratedReviewDocument` is the `ReadyReviewDocumentEntry` alias from B6 on.
- Settled boundaries: schema-2/3/4 migration is supported; only current presentations are converted/repaired; failed automatic conversion rolls back but remains discoverable; explicit repair preserves lifecycle state; ordinary terminal publish stays forbidden. Phase 3 authoring restrictions/dependency removals remain deferred. The existing JSON-shape/store boundary plus component parsing stays in Phase 2; this amendment does not introduce another schema redesign.
