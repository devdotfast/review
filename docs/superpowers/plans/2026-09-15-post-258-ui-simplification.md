# Post-#258 UI Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the rendering machinery that outlived its only consumers once reviews became plain React over a JSON document tree (PR #187) and comments were removed (PR #258), so a review renders through one document walk, one inline peek renderer, and no runtime rediscovery of facts the document already states.

**Architecture:** Five stacked pull requests on `chore/remove-comments-tui` (PR #258). Each PR is independently shippable and leaves every test suite green. Order: (A) delete dead plumbing, (B) derive TOC and section summaries from the hydrated document instead of the DOM, (C) collapse the three inline peek renderers to one, (D) delete client-side code-peek resolution and its server route, (E) record what was deliberately left alone.

**Tech Stack:** TypeScript 6, React 19 (JSX runtime), zod, vitest + jsdom (`packages/progressive-review`), node:test via tsx (`apps/whiteboard-desktop`), Code OSS fork (Monaco editor widgets), pnpm workspaces, oxlint/oxfmt.

**Spec:** This plan is its own spec. The audit it argues from lives in the conversation that produced it and is summarized in `~/.claude/projects/-Users-aiansiti-workable-review/memory/post-258-ui-simplification-audit.md`. Line numbers below are as of commit `bdbf38a17` on `chore/remove-comments-tui`; re-locate by symbol name if the file has moved.

## Global Constraints

- Base every branch on `origin/chore/remove-comments-tui`, not `origin/main`. Create the worktree from the core checkout: `cd /Users/aiansiti/workable/review && git fetch origin chore/remove-comments-tui && git worktree add -b chore/ui-simplification-a ../review-ui-simplification-a origin/chore/remove-comments-tui && cd ../review-ui-simplification-a && pnpm install`. One worktree per phase; later phases branch from the previous phase's branch.
- Before running `pnpm test` in a fresh worktree, run `pnpm --filter @dev.fast/review run build:tutorial-assets` once, or two tutorial test files fail for reasons unrelated to your change.
- `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/whiteboardProtocol.ts` is generated. Never edit it. Edit `packages/whiteboard-protocol/src/contracts.ts`, then run `pnpm --filter @dev.fast/whiteboard-desktop run protocol:sync`.
- Commit messages are one imperative sentence in sentence case, no prefix, no trailer, no attribution of any kind (`includeCoAuthoredBy` is already false). PR descriptions likewise carry no attribution.
- Full gate before every PR: from the repo root run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`. Compare any failure against the baseline list in `~/.claude/projects/-Users-aiansiti-workable-review/memory/fresh-worktree-baseline-test-failures.md` before blaming your diff.
- Per the repo `AGENTS.md`: do not add change-detector tests. When a task deletes a function, delete its tests with it; do not rewrite them to assert the new internals.
- Test file conventions: `packages/progressive-review` uses vitest; run one file with `cd packages/progressive-review && pnpm vitest run --config vitest.config.ts <path>`. jsdom tests start with `// @vitest-environment jsdom`. `apps/whiteboard-desktop` uses `node --test` through tsx; run all with `cd apps/whiteboard-desktop && pnpm test`, typecheck with `pnpm typecheck`.

---

## Regression gate

Every phase must clear three gates before its PR leaves draft. A phase that cannot clear a gate stops; do not carry an unexplained delta into the next phase.

**Gate 1 — automated suites.** From the repo root: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter @dev.fast/review run check:tutorial`. Success means zero failures that are not on the baseline failure list captured in Task 0. Deleted tests are expected (the plan names them); a test that newly fails is a regression, full stop.

**Gate 2 — UI snapshot diff.** The snapshot script below records what the running app renders for a fixed set of reviews. Each phase lists the exact fields allowed to change. Any other difference between the phase's snapshot and the previous phase's snapshot is a regression. This is the gate that catches what unit tests cannot: heading ids drifting, a peek rendering through the wrong path, a header losing its counts, a request that should be gone still firing.

**Gate 3 — hands-on checks.** A short list per phase of interactions the snapshot cannot capture (scrolling, focus, go-to-definition). Each has a stated pass condition.

### Task 0: Capture the baseline

Do this on the untouched `origin/chore/remove-comments-tui` tip, in the Phase A worktree before any edit.

**Files:**
- Create (scratchpad, not committed): `<scratchpad>/ui-snapshot.mjs`, `<scratchpad>/ui-snapshot-config.json`
- Create (scratchpad): `<scratchpad>/snapshots/baseline.json`, `<scratchpad>/baseline-tests.txt`

- [ ] **Step 1: Record the baseline test outcome**

```bash
pnpm --filter @dev.fast/review run build:tutorial-assets
pnpm test 2>&1 | tee <scratchpad>/baseline-tests.txt | tail -40
```
Copy the names of any failing test files into `<scratchpad>/baseline-failures.txt`. Compare against `~/.claude/projects/-Users-aiansiti-workable-review/memory/fresh-worktree-baseline-test-failures.md`; anything not on that list needs an explanation before you proceed.

- [ ] **Step 2: Prepare a stable review home**

The snapshot must run against the same reviews every time. Copy the live home once and never point the dev app at the live one:
```bash
rm -rf /tmp/rh && mkdir -p /tmp/rh && cp -R ~/.dev/reviews /tmp/rh/reviews
ls /tmp/rh/reviews | head
```
(A short path matters: the app opens a Unix socket under this home and the scratchpad path exceeds the macOS socket length limit.) Pick three reviews and record their UUIDs and titles in `ui-snapshot-config.json`: one with authored code peeks over changed lines, one with a sequence diagram tour, and the tutorial. If you cannot tell from the folder, open each in the app once and choose.
```json
{ "port": 9333, "reviews": [
  { "uuid": "<uuid-1>", "title": "<Home card title>" },
  { "uuid": "<uuid-2>", "title": "<Home card title>" },
  { "uuid": "<uuid-3>", "title": "<Home card title>" } ],
  "findQuery": "return" }
```

- [ ] **Step 3: Save the snapshot script**

```js
// <scratchpad>/ui-snapshot.mjs
// Usage: node ui-snapshot.mjs <config.json> <out.json>
// Requires the dev app running with DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT=<port>.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/Users/aiansiti/workable/review-remove-comments-tui/apps/whiteboard-desktop/code-oss/package.json");
const { chromium } = require("playwright-core");

const [configPath, outPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.port}`);
const page = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
if (!page) throw new Error("no workbench page");

const peekRequests = [];
page.on("request", (r) => { if (r.url().includes("/code-peek/resolve")) peekRequests.push(r.url()); });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

async function openWhiteboard(review) {
  // Home → card. Verify the role/name once against the Home DOM and adjust if needed.
  await page.getByRole("button", { name: "Home", exact: true }).click().catch(() => {});
  await page.getByText(review.title, { exact: true }).first().click();
  await page.getByRole("button", { name: "Review", exact: true, pressed: true }).waitFor();
  await page.waitForFunction(() => document.body.dataset.whiteboardCanvasReady === "true", null, { timeout: 60000 });
  // Force every lazy peek to mount by scrolling the document to the bottom.
  await page.evaluate(async () => {
    const root = document.querySelector(".whiteboard-canvas-root");
    const scroller = root?.querySelector("[data-review-scroll-region], .review-scroll-region") ?? root;
    for (let y = 0; y < (scroller?.scrollHeight ?? 0); y += 600) { scroller.scrollTop = y; await new Promise((r) => setTimeout(r, 120)); }
  });
  await page.waitForTimeout(1500);
}

async function snapshotReview() {
  return page.evaluate(() => {
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const editors = [...document.querySelectorAll(".whiteboard-inline-editor")].map((host) => ({
      path: host.dataset.reviewInlineEditor,
      kind: host.dataset.reviewInlineEditorKind ?? null,
      side: host.dataset.reviewInlineEditorSide ?? null,
      rangeRestricted: host.dataset.reviewInlineEditorRangeRestricted ?? null,
      additions: text(host.querySelector(".whiteboard-multidiff-additions")) || null,
      deletions: text(host.querySelector(".whiteboard-multidiff-deletions")) || null,
      hasOpenFile: !!host.querySelector(".whiteboard-multidiff-open"),
      height: Math.round(host.getBoundingClientRect().height),
      lines: [...host.querySelectorAll(".view-line")].map((l) => text(l)),
      error: text(host.nextElementSibling?.classList.contains("whiteboard-inline-editor-error") ? host.nextElementSibling : null) || null,
    }));
    return {
      title: text(document.querySelector(".whiteboard-canvas-root h1")),
      toc: [...document.querySelectorAll(".whiteboard-toc-link")].map((a) => ({ href: a.getAttribute("href"), text: text(a) })),
      headingIds: [...document.querySelectorAll(".whiteboard-canvas-root h2, .whiteboard-canvas-root h3")].map((h) => ({ id: h.id || null, text: text(h) })),
      sections: [...document.querySelectorAll(".whiteboard-section")].map((s) => ({
        title: s.dataset.whiteboardSection,
        collapsed: s.classList.contains("whiteboard-section--collapsed"),
        meta: text(s.querySelector(".whiteboard-section-meta")) || null,
      })),
      anchors: document.querySelectorAll("[data-whiteboard-anchor-id]").length,
      peeks: document.querySelectorAll(".code-peek").length,
      peekErrors: [...document.querySelectorAll(".peek-error")].map(text),
      editors,
      widgetCount: document.body.dataset.reviewInlineEditorWidgetCount ?? null,
      modelCount: document.body.dataset.reviewInlineEditorModelCount ?? null,
      strayAttributes: {
        blockIndex: document.querySelectorAll("[data-review-block-index]").length,
        scrollOwner: document.querySelectorAll("[data-review-scroll-owner]").length,
        authoredPeekRequests: document.querySelector("[data-review-authored-code-peek-request-count]")?.dataset.reviewAuthoredCodePeekRequestCount ?? null,
      },
    };
  });
}

async function collapseAllSections() {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll(".whiteboard-section-toggle[aria-expanded='true']")) b.click();
  });
  await page.waitForTimeout(300);
  const meta = await page.evaluate(() =>
    [...document.querySelectorAll(".whiteboard-section")].map((s) => ({ title: s.dataset.whiteboardSection, meta: (s.querySelector(".whiteboard-section-meta")?.textContent ?? "").trim() || null })));
  await page.evaluate(() => {
    for (const b of document.querySelectorAll(".whiteboard-section-toggle[aria-expanded='false']")) b.click();
  });
  return meta;
}

async function findMatchCount(query) {
  await page.keyboard.press("Meta+F");
  await page.keyboard.type(query);
  await page.waitForTimeout(800);
  const label = await page.evaluate(() => (document.querySelector(".whiteboard-find-count, [data-review-find-count]")?.textContent ?? "").trim());
  await page.keyboard.press("Escape");
  return label;
}

const out = { capturedAt: new Date().toISOString(), reviews: {} };
for (const review of config.reviews) {
  peekRequests.length = 0; consoleErrors.length = 0;
  const started = Date.now();
  await openWhiteboard(review);
  const snapshot = await snapshotReview();
  snapshot.collapsedMeta = await collapseAllSections();
  snapshot.findCount = await findMatchCount(config.findQuery);
  snapshot.openMs = Date.now() - started;
  snapshot.peekResolveRequests = peekRequests.length;
  snapshot.consoleErrors = consoleErrors;
  out.reviews[review.uuid] = snapshot;
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
await browser.close();
console.log("wrote", outPath);
```
Three selectors in this script are guesses you must confirm once against the running app and correct in place: the Home card locator in `openWhiteboard`, the scroll region selector, and the find-count element in `findMatchCount` (open `whiteboard-find.tsx` and use whatever class the count label has). Do that on the baseline run; after that the script is frozen for all phases.

- [ ] **Step 4: Run the app and capture**

Terminal 1:
```bash
cd apps/whiteboard-desktop && DEV_WHITEBOARD_HOME=/tmp/rh DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT=9333 pnpm app:run
```
Terminal 2, once the window is up:
```bash
node <scratchpad>/ui-snapshot.mjs <scratchpad>/ui-snapshot-config.json <scratchpad>/snapshots/baseline.json
```
Run it twice and diff the two runs: `diff <(jq -S . baseline.json) <(jq -S . baseline-2.json)`. Fields that differ between two runs of the same build (`openMs` always will; `height` may by a pixel) are noise. Write the noise list at the top of `ui-snapshot-config.json` as `"ignore": ["openMs", ...]` and exclude them from every later diff with `jq 'del(.. | .openMs?)'` or equivalent. Everything else must be identical run to run, or the baseline is not stable enough to gate on.

- [ ] **Step 5: Record the baseline numbers you will compare against**

In `<scratchpad>/snapshots/README.md`, note per review: editor count, editor kinds histogram, number of editors with counts, TOC length, `findCount`, `peekResolveRequests` (non-zero on baseline), `openMs`.

### How to run the gate for a phase

```bash
# after the phase's code is complete and Gate 1 passes:
cd apps/whiteboard-desktop && DEV_WHITEBOARD_HOME=/tmp/rh DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT=9333 pnpm app:run   # terminal 1
node <scratchpad>/ui-snapshot.mjs <scratchpad>/ui-snapshot-config.json <scratchpad>/snapshots/phase-<X>.json  # terminal 2
diff <(jq -S 'del(.. | .openMs?)' <scratchpad>/snapshots/phase-<prev>.json) <(jq -S 'del(.. | .openMs?)' <scratchpad>/snapshots/phase-<X>.json)
```
Paste the diff into the PR description under "Snapshot delta" and account for every line against the phase's allowed-delta table. A line you cannot account for is a regression: fix it or revert the task that caused it.

Note: `apps/whiteboard-desktop` dev builds wipe `out/vs/whiteboard/canvas`; `run.sh` re-copies the canvas bundle, so always launch through `pnpm app:run`, never the raw binary.

---

## File Structure

Files this plan creates:

| File | Responsibility |
|---|---|
| `packages/progressive-review/app/src/whiteboard-document-headings.ts` | Assign stable heading ids to hydrated `h2`/`h3` nodes and derive table-of-contents entries from them. Pure functions over `HydratedReviewNode[]`. |
| `packages/progressive-review/app/src/review-document-headings.test.ts` | Tests for the above. |
| `packages/progressive-review/app/src/whiteboard-section-summary.ts` | Count diagrams, code refs, and paragraphs in a section's hydrated children. Pure function. |
| `packages/progressive-review/app/src/review-section-summary.test.ts` | Tests for the above. |
| `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewUnifiedEditor.ts` | The one unified-diff `CodeEditorWidget` factory shared by inline peeks and the Files diff view. |

Files this plan deletes:

| File | Why |
|---|---|
| `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/reviewSelection.ts` | Only caller was the dead `editorSelectionChanged` emitter. |
| `packages/progressive-review/app/src/review-initial-data-context.ts` | No provider has existed since the Code OSS fork commit. |
| `packages/progressive-review/app/src/copy-command-button.tsx` | Zero importers. |
| `packages/progressive-review/app/src/review-document-prepare.ts` (+ test) | Load-time peek resolution goes away. |
| `packages/progressive-review/app/src/code-peek-resolution.ts` (+ test) | Same. |
| `packages/progressive-review/app/src/code-peek-loading.test.ts` | Tests `codePeekLoadState`, which goes away. |

---

## Phase A — Delete dead plumbing (PR 1)

Branch: `chore/ui-simplification-a`. Everything here is zero-behavior-change except the baton chip fix, which repairs an unstyled state.

**Success criteria (Phase A):**

| Gate | Pass condition |
|---|---|
| 1 | Full suite green except the baseline failure list. Test count drops only by the tests this phase names for deletion (`whiteboard-doc-meta` provider cases, `reviewFindText`, `rulerTickForEvent`, `createC4MapFlow`, fingerprint assertions). |
| 2 | `diff` between `baseline.json` and `phase-a.json` contains **only**: `strayAttributes.blockIndex` → `0`, `strayAttributes.scrollOwner` → `0`. Every other field, including every `toc`, `headingIds`, `sections`, `editors[*]`, `findCount`, `widgetCount`, `modelCount`, `peekErrors`, `consoleErrors`, is byte-identical. |
| 3 | (a) Select text inside an inline peek and inside a Files diff editor: no console error, no stuck selection. (b) Home: dismiss a review; the baton chip on the document title bar shows the removed-line colour, not the default text colour. (c) `git grep -n "activeEditorChanged\|editorSelectionChanged\|reviewLastSurfaceEvent" apps packages ':!*/out/*' ':!*/dist/*' ':!apps/whiteboard-desktop/code-oss/src/vs/workbench'` prints nothing. |

### Task A1: Remove the unsubscribed editor surface events

**Files:**
- Modify: `packages/whiteboard-protocol/src/contracts.ts:1430-1447`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/contrib/verbs/whiteboardVerbs.ts:82, 109-116, 256, 298, 385, 393-431`
- Delete: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/reviewSelection.ts`
- Regenerate: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/whiteboardProtocol.ts`

**Interfaces:**
- Produces: `WhiteboardSurfaceEvent` narrows to `{event:"themeChanged"} | {event:"showWhiteboardView"}`. Nothing else in this plan depends on it.

- [ ] **Step 1: Confirm there are no subscribers**

Run:
```bash
git grep -n "activeEditorChanged\|editorSelectionChanged" -- packages apps ':!*/dist/*' ':!*/out/*' ':!apps/whiteboard-desktop/code-oss/src/vs/workbench' ':!apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/whiteboardProtocol.ts'
```
Expected: exactly three hits, all in `whiteboardVerbs.ts` and `contracts.ts`. If an app file appears, stop and reassess.

- [ ] **Step 2: Remove the two schema members**

In `packages/whiteboard-protocol/src/contracts.ts`, `WhiteboardSurfaceEventSchema` becomes:
```ts
export const WhiteboardSurfaceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("themeChanged"),
    theme: whiteboardThemeSchema,
  }),
  z.strictObject({
    event: z.literal("showWhiteboardView"),
    view: whiteboardViewSchema,
  }),
]);
```
If `WhiteboardRangeSchema` is now unused in the file, leave it; other verbs use it (`git grep -n WhiteboardRangeSchema packages/whiteboard-protocol/src` to confirm).

- [ ] **Step 3: Remove the emitters and per-editor tracking in whiteboardVerbs.ts**

Delete, in order:
- the field `private readonly editorStores = new Map<string, DisposableStore>();` (line 82)
- the constructor block that calls `this.trackEditor` for every existing editor and registers `onCodeEditorAdd` / `onCodeEditorRemove` (lines 109-116)
- the three `this.emitEditorState(...)` calls (lines 256, 298, 385)
- the methods `trackEditor`, `untrackEditor`, `emitEditorState` (lines 393-431)
- the import of `reviewSelectionRange` and the import of `DisposableStore` if it is now unused
- in `browser/parts/canvas/whiteboardCanvasPart.ts:278-283`, the `dataset["reviewLastSurfaceEvent"] = event.event` assignment (a test hook with no reader; keep the `this.surfaceEvents.fire(event)` line)

Keep `editorIdentity` (lines 434+); it is still used by the open-editors verb at lines 211-214.

- [ ] **Step 4: Delete reviewSelection.ts and regenerate the protocol**

```bash
git rm apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/reviewSelection.ts
pnpm --filter @dev.fast/whiteboard-desktop run protocol:sync
```

- [ ] **Step 5: Typecheck and test the desktop**

```bash
cd apps/whiteboard-desktop && pnpm typecheck && pnpm test
```
Expected: both pass. A `switch` over `event.event` in the app (`App.tsx:451`, `debug-settings.tsx:50`) only tests for the two surviving events, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add -A packages/whiteboard-protocol/src/contracts.ts apps/whiteboard-desktop/code-oss/src/vs/review
git commit -m "Remove the editor surface events nothing subscribes to"
```

### Task A2: Delete the provider-less initial-data context

**Files:**
- Delete: `packages/progressive-review/app/src/review-initial-data-context.ts`
- Modify: `packages/progressive-review/app/src/App.tsx:57, 369, 394-398`
- Modify: `packages/progressive-review/app/src/whiteboard-doc-meta.tsx:21, 37-47, 61-83`
- Modify: `packages/progressive-review/app/src/software-map/SoftwareMap.tsx:37, 329` and every later use of `initialData` in that file
- Modify: `packages/progressive-review/app/src/whiteboard-doc-meta.test.tsx:63, 143`

- [ ] **Step 1: Prove the context is never provided**

```bash
git grep -n "ReviewInitialDataContext.Provider\|ReviewInitialDataContext\b" -- packages apps ':!*.test.*' ':!*/dist/*' ':!packages/progressive-review/app/src/review-initial-data-context.ts'
```
Expected: no output.

- [ ] **Step 2: Rewrite the three readers to their fetch branch**

`whiteboard-doc-meta.tsx`: remove the import at line 21 and the `initialData`/`initialDocumentMeta`/`initialDiffStats` locals. The two `useState` initializers become `useState<WhiteboardDocumentMetaState | null>(null)` and delete the `initialDiff` state entirely (grep the file for `initialDiff` and remove each use; where it was a fallback alongside `diffFiles`, keep only the `diffFiles` branch). The `/document-meta` effect loses its `if (!initialDocumentMeta)` guard and its dependency:
```tsx
useEffect(() => {
  const controller = new AbortController();
  whiteboardFetch("/document-meta", { signal: controller.signal })
    .then(async (response) => {
      const json: JsonValue = await response.json();
      if (!response.ok || !isJsonObject(json) || json.ok !== true) return;
      setMeta(
        documentMetaState({
          updatedAtMs: jsonNumber(json.updatedAtMs),
          pullRequestNumber: jsonNumber(json.pullRequestNumber),
          pullRequestUrl: jsonString(json.pullRequestUrl),
        }),
      );
    })
    .catch(() => {});
  return () => controller.abort();
}, [whiteboardFetch]);
```

`App.tsx`: remove the import (line 57) and line 369. `filesTabFileCount` becomes:
```tsx
const filesTabFileCount = diffScope
  ? diffScope.fileCount
  : diffFiles.status === "loaded"
    ? diffFiles.files.length
    : null;
```

`SoftwareMap.tsx`: remove the import (line 37) and line 329, then `grep -n initialData` in the file and take the null branch at each use (typically a `?.softwareMapResolvedData.find(...)` seed that becomes `undefined`).

- [ ] **Step 3: Delete the module and fix the tests**

```bash
git rm packages/progressive-review/app/src/review-initial-data-context.ts
```
In `whiteboard-doc-meta.test.tsx`, the two tests at lines 63 and 143 wrap the component in `ReviewInitialDataContext.Provider`. Remove the wrapper. If the test then asserts on values that only the provider supplied, make the test's fetch stub return those values through `/document-meta` instead, since that is the only path production has.

- [ ] **Step 4: Run the affected tests**

```bash
cd packages/progressive-review && pnpm vitest run --config vitest.config.ts app/src/whiteboard-doc-meta.test.tsx app/src/App.test.ts app/src/software-map
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A packages/progressive-review/app/src
git commit -m "Drop the initial-data context that no loader has provided since the fork"
```

### Task A3: Strip orphaned DOM fingerprints and the scroll-owner attribute

**Files:**
- Modify: `packages/progressive-review/src/document/rehype-review-targets.ts`
- Modify: `packages/progressive-review/app/src/App.tsx:609`, `packages/progressive-review/app/src/whiteboard-components.tsx:143`
- Modify: fixtures `packages/progressive-review/src/fixtures/legacy-reviews/*.expected-document.json`
- Modify: tests that assert `data-review-block-index`: `review-components.test.tsx`, `review-document-renderer.test.tsx`, `tutorial-document.test.tsx`, `src/review-document-examples.test.ts`, `src/whiteboard-document-materialize.test.ts`

- [ ] **Step 1: Prove nothing reads the stamps**

```bash
git grep -n "data-review-block-index\|data-review-table\|data-review-row\|data-review-column\|review-scroll-owner\|reviewScrollOwner" -- packages apps ':!*.test.*' ':!*/dist/*' ':!*/fixtures/*'
```
Expected: only the producer lines in `rehype-review-targets.ts`, `App.tsx:609`, `whiteboard-components.tsx:143`. `data-review-block-tag` is NOT in this grep on purpose; it is still read at `whiteboard-components.tsx:283`.

- [ ] **Step 2: Reduce the rehype plugin to the block tag**

Replace the file body with:
```ts
import type { Element, Nodes, Root } from "hast";

const REVIEW_BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "pre"]);

/** Marks block elements so a section can recognise its own heading even when
 * an override component renders it. */
export function rehypeReviewTargets() {
  return (tree: Root) => {
    walk(tree, (element) => {
      if (REVIEW_BLOCK_TAGS.has(element.tagName)) {
        element.properties["data-review-block-tag"] = element.tagName;
      }
    });
  };
}

function walk(node: Nodes, visit: (element: Element) => void): void {
  if (node.type === "element") visit(node);
  if (!("children" in node)) return;
  for (const child of node.children) walk(child, visit);
}
```

- [ ] **Step 3: Remove the scroll-owner attribute**

Delete the `data-review-scroll-owner={...}` JSX attribute at `App.tsx:609` and `data-review-scroll-owner="panel"` at `whiteboard-components.tsx:143`.

- [ ] **Step 4: Rewrite the fixtures with a script, not sed**

Save to the scratchpad and run once:
```js
// strip-fingerprints.mjs
import fs from "node:fs";
const DROP = new Set(["data-review-block-index","data-review-table","data-review-row","data-review-column"]);
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  if (node.props && typeof node.props === "object") for (const key of DROP) delete node.props[key];
  for (const value of Object.values(node)) walk(value);
}
for (const file of process.argv.slice(2)) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  walk(json);
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
```
```bash
node strip-fingerprints.mjs packages/progressive-review/src/fixtures/legacy-reviews/*.expected-document.json
git diff --stat packages/progressive-review/src/fixtures
```
Expected: only fingerprint lines removed. If the fixture's existing indentation differs from two spaces, match it by re-running `pnpm format` or by reading `legacy-review-fixtures.test.ts` for a regeneration flag and using that instead.

- [ ] **Step 5: Update the tests**

Run the five test files listed above; each failure is an assertion on a removed attribute. Delete the assertion line (or the `data-review-block-index` key from an expected object). Do not replace it with an assertion on `data-review-block-tag` unless the test was already about section heading detection.
```bash
cd packages/progressive-review && pnpm vitest run --config vitest.config.ts app/src/review-components.test.tsx app/src/review-document-renderer.test.tsx app/src/tutorial-document.test.tsx src/review-document-examples.test.ts src/whiteboard-document-materialize.test.ts src/legacy-review-fixtures.test.ts
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add -A packages/progressive-review
git commit -m "Stop stamping comment target fingerprints on document blocks"
```

### Task A4: Collapse the always-true unifiedDiff ternary and demote over-exports

**Files:**
- Modify: `packages/progressive-review/app/src/whiteboard-components.tsx:312-321, 421-435, 664-690, 1107-1143`

- [ ] **Step 1: Make the anchor required in WhiteboardPeekContentView**

Replace the component (lines 1107-1143) with:
```tsx
function WhiteboardPeekContentView({
  anchor,
  content,
  active,
  onNativeFocus,
}: {
  anchor: AnchorRef;
  content: WhiteboardPeekContent;
  active?: boolean;
  onNativeFocus?: () => void;
}) {
  if (content.kind === "resolved-code") {
    return (
      <CodePeekCard
        input={content.input}
        active={active}
        heightMode="content"
        onNativeFocus={onNativeFocus}
        unifiedDiff
      />
    );
  }

  if (content.kind === "inline-code") {
    return (
      <AuthoredCodeSurface
        anchor={anchor}
        code={content.text}
        language={content.language}
      />
    );
  }

  return null;
}
```
Both callers (`:732` and `:1097`) already pass a non-optional `AnchorRef`, so nothing else changes.

- [ ] **Step 2: Remove `export` from the four module-private symbols**

`ProsePeekAnchorProps` (line 312), `keepAnchorLinkVisible` (line 421), `WhiteboardPeekPanel` (line 664), `WhiteboardPeekContentView` (done above). Confirm with:
```bash
git grep -n "ProsePeekAnchorProps\|keepAnchorLinkVisible\|WhiteboardPeekPanel\b\|WhiteboardPeekContentView" -- packages/progressive-review/app/src ':!packages/progressive-review/app/src/whiteboard-components.tsx'
```
Expected: no output.

- [ ] **Step 3: Typecheck and test**

```bash
cd packages/progressive-review && pnpm typecheck && pnpm vitest run --config vitest.config.ts app/src/review-components.test.tsx app/src/side-peek-validation.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git commit -am "Make authored side peeks unconditionally unified"
```

### Task A5: Delete zero-reference exports and fix the baton chip CSS

**Files:**
- Delete: `packages/progressive-review/app/src/copy-command-button.tsx`
- Modify: `packages/progressive-review/app/src/whiteboard-find-text.ts:61` (`reviewFindText`), `app/src/review-find.test.ts` (its tests)
- Modify: `packages/progressive-review/app/src/database-lens.tsx` (`FieldLeaf`)
- Modify: `packages/progressive-review/app/src/trace-ruler.tsx` (`rulerTickForEvent`) and `trace-ruler.test.tsx`
- Modify: `packages/progressive-review/app/src/software-map/c4-layout-geometry.ts` (`createC4MapFlow`) and its test
- Modify: `packages/progressive-review/app/src/styles.css:3081-3095, 3112`

- [ ] **Step 1: Re-verify each symbol is unreferenced before deleting it**

For each of `CopyCommandButton`, `reviewFindText`, `FieldLeaf`, `rulerTickForEvent`, `createC4MapFlow`:
```bash
git grep -nw <SYMBOL> -- packages apps ':!*/dist/*'
```
Expected: only the definition and, for some, a `.test.` file. Delete the definition and the test cases that call it. If a symbol turns out to be used, leave it and note it in the PR.

- [ ] **Step 2: Fix the baton chip variants**

`App.tsx:861` emits `review-baton-chip--${outcome}` with `outcome` in `approved | changes-requested | dismissed`. In `styles.css` rename `.review-baton-chip--rejected` (line 3093) and `.review-baton-chip--rejected .whiteboard-baton-glyph` (line 3112) to `--dismissed`, and delete the `.review-baton-chip--awaiting` rule (lines 3081-3083).

- [ ] **Step 3: Run the touched tests, then the full gate**

```bash
cd packages/progressive-review && pnpm vitest run --config vitest.config.ts app/src/review-find.test.ts app/src/trace-ruler.test.tsx app/src/software-map/c4-layout-geometry.test.ts
cd ../.. && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git commit -am "Delete unreferenced exports and style the dismissed baton chip"
```

### Task A6: Remove the verbs nobody sends and the wire fields nobody reads

**Files:**
- Modify: `packages/whiteboard-protocol/src/contracts.ts:1351, 1397, 1109` (the `openFile` and `state` verb members; `codexThreadId`)
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/contrib/verbs/whiteboardVerbs.ts:130, 181` (their `case` arms and any helper only they call)
- Modify: `packages/progressive-review/src/server/desktop-server.ts:2526`, `packages/progressive-review/src/types.ts:53-70`
- Modify: `packages/progressive-review/app/src/database-lens.tsx:1138` (`storesForUseCase`)

- [ ] **Step 1: Prove each is orphaned**

```bash
git grep -n 'name: "state"\|name: "openFile"' -- packages apps ':!*/dist/*' ':!*/out/*' ':!*.test.*'     # expect: none
git grep -nw "codexThreadId" -- packages apps ':!*/dist/*' ':!*/out/*' ':!*.test.*'                   # expect: schema, types.ts, one writer in desktop-server.ts, and authoring-session.ts reading the ENV VAR (not the wire field)
git grep -nw "storesForUseCase" -- packages ':!*/dist/*'                                              # expect: the definition only
git grep -nw "WhiteboardSession" -- packages/progressive-review/src ':!*/dist/*' | grep -v "types.ts:53"   # expect: none matching the bare name
```

- [ ] **Step 2: Delete**

- `contracts.ts`: remove the two verb union members and `openFileArgsSchema` if only `openFile` used it; remove `codexThreadId` from the session schema at line 1109.
- `whiteboardVerbs.ts`: remove `case "openFile"` and `case "state"` arms. Keep `openFileEditor`; `revealCode` still calls it. If `case "state"` was the only caller of the open-editors listing at lines 205-220 (the code that uses `editorIdentity`), delete that too, and then `editorIdentity` if it has no other caller.
- `desktop-server.ts:2526`: remove the `codexThreadId:` property from the session wire object. `types.ts`: remove `codexThreadId?: string` and the unreferenced `export interface WhiteboardSession` block.
- `database-lens.tsx:1138`: delete `storesForUseCase`.
- Regenerate the protocol: `pnpm --filter @dev.fast/whiteboard-desktop run protocol:sync`.

- [ ] **Step 3: Verify**

```bash
pnpm typecheck && cd apps/whiteboard-desktop && pnpm test && cd ../../packages/progressive-review && pnpm vitest run --config vitest.config.ts src/server app/src/database-lens.test.ts
```
Any test that sent `state` or `openFile` or asserted `codexThreadId` on the wire is a test of the deleted feature; delete it.

- [ ] **Step 4: Commit and open PR 1**

```bash
git commit -am "Remove the verbs nothing sends and the session field nothing reads"
git push -u origin chore/ui-simplification-a
gh pr create --base chore/remove-comments-tui --draft --title "Delete plumbing left behind by the comments removal" --body "<summarise A1–A6; state that the only visible change is the dismissed baton chip now taking the removed-line colour; paste the Gate 2 snapshot delta>"
```

---

## Phase B — Derive TOC and section summaries from the document (PR 2)

Branch: `chore/ui-simplification-b` from `chore/ui-simplification-a`. Behavior change: heading ids are now assigned at hydrate time and rendered as `id` attributes, so anchor scrolling no longer waits for the TOC's first collection pass.

**Success criteria (Phase B):**

| Gate | Pass condition |
|---|---|
| 1 | Full suite green except baseline. New tests `review-document-headings.test.ts` and `review-section-summary.test.ts` pass. `whiteboard-toc.test.tsx` passes with the mutation-collection cases removed. |
| 2 | `diff phase-a.json phase-b.json` is **empty** for `toc`, `headingIds`, `sections`, `collapsedMeta`, `editors`, `findCount`. This is the whole point of the phase: identical ids in identical order, identical summary labels, produced from the tree instead of the DOM. The only tolerated delta is `strayAttributes` if Phase A left any, which it must not have. If a `toc[*].href` or `headingIds[*].id` differs, the slug or uniqueness logic diverged; fix it rather than accepting the new id, because persisted scroll positions and external links key on the old ids. |
| 3 | (a) Click every TOC entry in the tour review; each scrolls to its heading and the entry highlights; a heading inside a collapsed section expands the section first. (b) Collapse a section: the meta label reads the same as the baseline (e.g. "2 diagrams, 5 code refs"). (c) Open the tutorial: chapters still expand on activation and the Contents rail lists them. (d) Resize the window below 1360px wide: the rail collapses to the pill, the pill names the current section while scrolling. |

### Task B1: Assign heading ids at hydrate time

**Files:**
- Create: `packages/progressive-review/app/src/whiteboard-document-headings.ts`
- Create: `packages/progressive-review/app/src/review-document-headings.test.ts`
- Modify: `packages/progressive-review/app/src/review-document-hydrate.ts:78-90`

**Interfaces:**
- Produces:
  ```ts
  export type WhiteboardTocLevel = "h2" | "h3";
  export interface WhiteboardTocEntry { id: string; text: string; level: WhiteboardTocLevel }
  export function assignReviewHeadingIds(body: HydratedReviewNode[]): void;
  export function reviewTocEntries(body: HydratedReviewNode[]): WhiteboardTocEntry[];
  ```
  `assignReviewHeadingIds` mutates `props.id` on every `h2`/`h3` element node that lacks one, using the same slug and uniqueness rules `whiteboard-toc.tsx` uses today (`slugifyHeading`, `uniqueHeadingId`, `normalizeHeadingText`, moved here verbatim). `reviewTocEntries` reads those ids back; it never assigns.

- [ ] **Step 1: Write the failing tests**

```ts
// review-document-headings.test.ts
import { describe, expect, it } from "vitest";
import type { HydratedReviewNode } from "./review-document-hydrate";
import { assignReviewHeadingIds, reviewTocEntries } from "./whiteboard-document-headings";

const text = (value: string): HydratedReviewNode => ({ type: "text", value });
const el = (tag: "h2" | "h3" | "p" | "em", children: HydratedReviewNode[], props = {}): HydratedReviewNode =>
  ({ type: "element", tag, props, children }) as HydratedReviewNode;
const section = (children: HydratedReviewNode[]): HydratedReviewNode =>
  ({ type: "component", name: "WhiteboardSection", props: { title: "s" }, children }) as HydratedReviewNode;

describe("assignReviewHeadingIds", () => {
  it("slugs heading text and keeps duplicates unique", () => {
    const body = [section([el("h2", [text("Data flow")]), el("h3", [text("Data flow")])])];
    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body)).toEqual([
      { id: "data-flow", text: "Data flow", level: "h2" },
      { id: "data-flow-2", text: "Data flow", level: "h3" },
    ]);
  });

  it("keeps an authored id and flattens inline markup", () => {
    const body = [el("h2", [text("The "), el("em", [text("hot")]), text(" path")], { id: "hot" })];
    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body)).toEqual([{ id: "hot", text: "The hot path", level: "h2" }]);
  });

  it("ignores headings with no text and non-heading blocks", () => {
    const body = [el("h2", []), el("p", [text("body")])];
    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd packages/progressive-review && pnpm vitest run --config vitest.config.ts app/src/review-document-headings.test.ts
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// whiteboard-document-headings.ts
import type { HydratedReviewNode } from "./review-document-hydrate";

export type WhiteboardTocLevel = "h2" | "h3";

export interface WhiteboardTocEntry {
  id: string;
  text: string;
  level: WhiteboardTocLevel;
}

/** Gives every h2/h3 without an authored id a stable slug, unique per document. */
export function assignReviewHeadingIds(body: HydratedReviewNode[]): void {
  const usedIds = new Set<string>();
  const headings = collectHeadings(body);
  for (const heading of headings) {
    const authored = typeof heading.node.props.id === "string" ? heading.node.props.id.trim() : "";
    if (authored) usedIds.add(authored);
  }
  for (const heading of headings) {
    if (typeof heading.node.props.id === "string" && heading.node.props.id.trim()) continue;
    if (!heading.text) continue;
    const id = uniqueHeadingId(slugifyHeading(heading.text), usedIds);
    heading.node.props.id = id;
    usedIds.add(id);
  }
}

export function reviewTocEntries(body: HydratedReviewNode[]): WhiteboardTocEntry[] {
  return collectHeadings(body).flatMap(({ node, text, level }) => {
    const id = typeof node.props.id === "string" ? node.props.id : "";
    return text && id ? [{ id, text, level }] : [];
  });
}

interface HeadingNode {
  node: Extract<HydratedReviewNode, { type: "element" }>;
  text: string;
  level: WhiteboardTocLevel;
}

function collectHeadings(nodes: HydratedReviewNode[]): HeadingNode[] {
  const found: HeadingNode[] = [];
  const walk = (node: HydratedReviewNode) => {
    if (node.type === "text") return;
    if (node.type === "element" && (node.tag === "h2" || node.tag === "h3")) {
      found.push({ node, text: normalizeHeadingText(nodeText(node)), level: node.tag });
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return found;
}

function nodeText(node: HydratedReviewNode): string {
  if (node.type === "text") return node.value;
  return node.children.map(nodeText).join("");
}

function uniqueHeadingId(baseId: string, usedIds: Set<string>): string {
  const base = baseId || "section";
  let candidate = base;
  let index = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 4: Call it from hydrate**

In `hydrateReviewDocument`, after building `body`:
```ts
const body = data.body.map((node) => hydrateNode(node, anchors));
assignReviewHeadingIds(body);
return { contentHash: load.contentHash, body, anchors, /* unchanged */ };
```
`hydrateNode` spreads `...node` for element nodes, so `props` is the parsed object and safe to mutate; the renderer spreads `node.props` into `createElement`, so `id` reaches the DOM with no renderer change.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run --config vitest.config.ts app/src/review-document-headings.test.ts app/src/review-document-hydrate.test.ts app/src/review-document-renderer.test.tsx
```
Expected: pass. If a hydrate test asserts deep equality on a body containing `h2`, add `id` to its expectation.

- [ ] **Step 6: Commit**

```bash
git add packages/progressive-review/app/src/whiteboard-document-headings.ts packages/progressive-review/app/src/review-document-headings.test.ts packages/progressive-review/app/src/review-document-hydrate.ts
git commit -m "Assign heading ids when a review document hydrates"
```

### Task B2: Feed the table of contents from the document

**Files:**
- Modify: `packages/progressive-review/app/src/whiteboard-toc.tsx` (delete lines 114-176 collection effect, lines 397-435 `collectHeadingEntries`/`uniqueHeadingId`/`slugifyHeading`/`normalizeHeadingText`, and `tocEntriesEqual` if unused after)
- Modify: `packages/progressive-review/app/src/App.tsx:619`
- Modify: `packages/progressive-review/app/src/whiteboard-toc.test.tsx`

**Interfaces:**
- Consumes: `reviewTocEntries`, `WhiteboardTocEntry` from Task B1.
- Produces: `export function WhiteboardToc({ entries }: { entries: readonly WhiteboardTocEntry[] }): ReactElement | null`.

- [ ] **Step 1: Rewrite the TOC tests to pass entries**

`whiteboard-toc.test.tsx` builds an article via `innerHTML` and waits for collection. Change `renderArticle` to also stamp ids (`<h2 id="${slug}">`) and render `<WhiteboardToc entries={[...]} />` with matching entries. Delete the `settle()` waits that exist only for the rAF and 80/300 ms re-collects; keep one `act` for the initial render. Remove any test whose subject is "collects after mutation"; that behavior no longer exists.

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --config vitest.config.ts app/src/whiteboard-toc.test.tsx
```
Expected: FAIL, `entries` prop unknown.

- [ ] **Step 3: Replace the collection effect with a prop**

In `whiteboard-toc.tsx`:
- `export function WhiteboardToc({ entries }: { entries: readonly WhiteboardTocEntry[] })`; delete `const [entries, setEntries] = useState(...)`.
- Delete the effect at lines 114-176 (the one that owns `collect`, `scheduleCollect`, the timeouts, and the `MutationObserver`).
- `setActive` initialisation: replace with an effect keyed on `entries` that resets `active` to `entries[0]?.id ?? null` when the current value is not in `entries`.
- Delete `collectHeadingEntries`, `uniqueHeadingId`, `slugifyHeading`, `normalizeHeadingText`, and `tocEntriesEqual`. Import `WhiteboardTocEntry` from `./review-document-headings` and delete the local `WhiteboardTocLevel`/`WhiteboardTocEntry` declarations.
- Keep the scroll-spy effect (lines 178-255), `scrollTo`, and all rendering unchanged. They query headings by id, which the renderer now emits.

- [ ] **Step 4: Pass entries from App**

At `App.tsx:619`, inside the `documentState.state === "ready"` branch:
```tsx
<WhiteboardToc entries={tocEntries} />
```
with, near the other memos in the same component:
```tsx
const tocEntries = useMemo(
  () => documentState.state === "ready" ? reviewTocEntries(documentState.document.body) : [],
  [documentState],
);
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
pnpm typecheck && pnpm vitest run --config vitest.config.ts app/src/whiteboard-toc.test.tsx app/src/App.test.ts app/src/tutorial-experience.test.tsx
```
Expected: pass. The tutorial renders through the same hydrate path, so its chapters keep their ids.

- [ ] **Step 6: Commit**

```bash
git commit -am "Build the table of contents from the hydrated document"
```

### Task B3: Compute section summaries at hydrate time

**Files:**
- Create: `packages/progressive-review/app/src/whiteboard-section-summary.ts` (+ test)
- Modify: `packages/progressive-review/app/src/review-document-hydrate.ts:95-115` (`componentHydrators`)
- Modify: `packages/progressive-review/app/src/whiteboard-components.tsx:153-205`

**Interfaces:**
- Produces:
  ```ts
  export interface WhiteboardSectionSummary { diagrams: number; codeRefs: number; paragraphs: number }
  export function reviewSectionSummary(children: HydratedReviewNode[]): WhiteboardSectionSummary;
  ```
  Counts: `diagrams` = component nodes named `SequenceDiagram` or `DatabaseLens`; `codeRefs` = component nodes named `AnchorLink`, `CodePeek`, or `TraceQuote`; `paragraphs` = element nodes with tag `p`. Descend through every node. This mirrors today's DOM selectors (`.sequence-diagram, .database-lens`, `a[data-whiteboard-anchor-id], .code-peek`, `p`); the `.software-map` selector had no in-document producer and is dropped.

- [ ] **Step 1: Write the failing test**

```ts
// review-section-summary.test.ts
import { expect, it } from "vitest";
import type { HydratedReviewNode } from "./review-document-hydrate";
import { reviewSectionSummary } from "./whiteboard-section-summary";

const p: HydratedReviewNode = { type: "element", tag: "p", props: {}, children: [] };
const component = (name: string, children: HydratedReviewNode[] = []): HydratedReviewNode =>
  ({ type: "component", name, props: {}, children }) as HydratedReviewNode;

it("counts diagrams, code refs and paragraphs at any depth", () => {
  expect(
    reviewSectionSummary([
      p,
      component("SequenceDiagram"),
      component("DatabaseLens", [p, component("AnchorLink")]),
      component("CodePeek"),
      component("TraceQuote"),
    ]),
  ).toEqual({ diagrams: 2, codeRefs: 3, paragraphs: 2 });
});
```

- [ ] **Step 2: Run to see it fail**, then **Step 3: Implement**

```ts
// whiteboard-section-summary.ts
import type { HydratedReviewNode } from "./review-document-hydrate";

export interface WhiteboardSectionSummary {
  diagrams: number;
  codeRefs: number;
  paragraphs: number;
}

const DIAGRAMS = new Set(["SequenceDiagram", "DatabaseLens"]);
const CODE_REFS = new Set(["AnchorLink", "CodePeek", "TraceQuote"]);

export function reviewSectionSummary(children: HydratedReviewNode[]): WhiteboardSectionSummary {
  const summary = { diagrams: 0, codeRefs: 0, paragraphs: 0 };
  const walk = (node: HydratedReviewNode) => {
    if (node.type === "text") return;
    if (node.type === "component") {
      if (DIAGRAMS.has(node.name)) summary.diagrams += 1;
      if (CODE_REFS.has(node.name)) summary.codeRefs += 1;
    } else if (node.tag === "p") {
      summary.paragraphs += 1;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of children) walk(child);
  return summary;
}
```

- [ ] **Step 4: Attach it in the hydrator**

`componentHydrators` in `review-document-hydrate.ts` currently has only `DatabaseLens`. The hydrator signature receives the raw node and the walked props, but children are hydrated after props. Change `hydrateComponentNode` to hydrate children first and pass them:
```ts
type ComponentHydrators = {
  [K in WhiteboardAuthoringComponentName]?: (
    node: Extract<WhiteboardComponentNode, { name: K }>,
    props: HydratedReviewComponentProps,
    children: HydratedReviewNode[],
  ) => HydratedReviewComponentProps;
};

const componentHydrators: ComponentHydrators = {
  DatabaseLens: (node, props) => ({ /* unchanged */ }),
  WhiteboardSection: (_node, props, children) => ({
    ...props,
    summary: reviewSectionSummary(children),
  }),
};

function hydrateComponentNode<K extends WhiteboardAuthoringComponentName>(node, anchors) {
  const walked = hydrateComponentProps(node.props, anchors);
  const children = node.children.map((child) => hydrateNode(child, anchors));
  const hydrate = componentHydrators[node.name];
  return { type: "component", name: node.name, props: hydrate ? hydrate(node, walked, children) : walked, children };
}
```
`WhiteboardSectionSummary` is three numbers, so it satisfies `HydratedReviewPropValue` without a new union member.

- [ ] **Step 5: Read the summary in WhiteboardSection**

In `whiteboard-components.tsx`:
- Delete the local `interface WhiteboardSectionSummary` (line 153) and import it from `./review-section-summary`.
- Add next to the component: `const reviewSectionRenderPropsSchema = whiteboardSectionPropsSchema.extend({ summary: z.object({ diagrams: z.number(), codeRefs: z.number(), paragraphs: z.number() }).optional() });` and parse with it instead of `whiteboardSectionPropsSchema` (that schema is a `strictObject` in `authoring.ts:923`, so an unknown key would fail; `.extend` keeps strictness for the authoring shape while admitting the hydrated key).
- Delete `const [summary, setSummary] = useState(...)` and the `useLayoutEffect` at lines 192-205; use `summary` from the parsed props. `bodyRef` stays; the expand-event effect still needs it.

- [ ] **Step 6: Run tests, typecheck, commit, open PR 2**

```bash
pnpm typecheck && pnpm vitest run --config vitest.config.ts app/src/review-section-summary.test.ts app/src/review-components.test.tsx app/src/review-document-hydrate.test.ts
cd ../.. && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
git add -A packages/progressive-review/app/src
git commit -m "Summarise collapsed sections from the document tree"
git push -u origin chore/ui-simplification-b
gh pr create --base chore/ui-simplification-a --draft --title "Derive the table of contents and section summaries from the document" --body "<summarise B1–B3; call out that heading ids now come from hydrate>"
```

---

## Phase C — One inline peek renderer (PR 3)

Branch: `chore/ui-simplification-c` from `chore/ui-simplification-b`. **Behavior change:** every inline peek renders the one-column unified diff. The app-wide split/unified toggle keeps governing the Files diff view only. The software-map code inspector loses its optional side-by-side peek. Peek header counts now reflect the added and deleted rows visible in the peek window (which includes three context lines each side) rather than the server's range-exact count; state this in the PR.

**Success criteria (Phase C):**

| Gate | Pass condition |
|---|---|
| 1 | Full suite green except baseline. `reviewCodeResourceService.test.ts` and `reviewUnifiedDefinition.test.ts` pass unchanged (they cover the renderer that survives). `InlineCodeEditor.test.tsx`/`CodePeek.test.tsx` pass with `unifiedDiff` keys removed from expectations. |
| 2 | `diff phase-b.json phase-c.json` may contain **only**: (i) `editors[*].kind` changing from the multi-diff value to `"unified"` for editors whose baseline kind was multi-diff, never to anything else, and never for editors that were already `"unified"` or `"code"`; (ii) `editors[*].additions`/`deletions` numeric changes on those same editors, each explained by a change within the three context lines (spot-check two by opening the file); (iii) `editors[*].height` changes on those same editors only. **Must be unchanged:** `editors[*].path`, `side`, `lines` (the visible text), `hasOpenFile`, `error`; every editor that had counts on the baseline still has counts (`additions !== null`); `widgetCount`, `modelCount` (the unified path shares models, so the count must not rise); `findCount`; `peekErrors`; `consoleErrors` empty. Run the snapshot twice, once with the diff layout set to split and once unified, and diff those two against each other: they must be identical, proving peeks no longer follow the toggle. |
| 3 | (a) Software-map inspector: open a changed node; the peek renders unified with counts and Open file works. (b) Inside an authored peek, Cmd-click or F12 on a symbol defined in the same repo: navigates to the definition (this exercises `reviewUnifiedDefinition.ts`). Hover a symbol: hover shows. (c) Find (Cmd-F) for the config query: the match count equals the baseline and stepping into a match inside a collapsed peek expands and reveals it. (d) A tour stop's peek scrolls its highlighted range into view when the stop activates. (e) Scroll the whole document to the bottom and back: no peek shows a blank body or a clipped last line. (f) Files tab in both layouts: unchanged from baseline. |

### Task C1: Extract the shared unified editor factory

**Files:**
- Create: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewUnifiedEditor.ts`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewInlineEditorService.ts:712-782`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewUnifiedFilesEditor.ts:40-116`

**Interfaces:**
- Produces:
  ```ts
  export function reviewUnifiedDiffDecorations(rows: readonly ReviewUnifiedDiffRow[]): IModelDeltaDecoration[];
  export function reviewUnifiedLineNumbers(rows: readonly ReviewUnifiedDiffRow[]): (lineNumber: number) => string;
  ```
  Both call sites build the same decoration array (`line-insert`/`line-delete`, `gutter-insert`/`gutter-delete`, `review-unified-line-number-added`/`-deleted`) and the same `lineNumbers` callback. The editor *options* remain per call site because they genuinely differ (the Files editor hides scrollbars and disables wheel handling; the peek does not).

- [ ] **Step 1: Write the module**

```ts
import { Range } from "../../editor/common/core/range.js";
import type { IModelDeltaDecoration } from "../../editor/common/model.js";
import type { ReviewUnifiedDiffRow } from "../common/reviewUnifiedDiff.js";

export function reviewUnifiedDiffDecorations(
  rows: readonly ReviewUnifiedDiffRow[],
): IModelDeltaDecoration[] {
  return rows.flatMap((row) => {
    if (row.kind === "unchanged") return [];
    const added = row.kind === "added";
    return [
      {
        range: new Range(row.lineNumber, 1, row.lineNumber, Number.MAX_SAFE_INTEGER),
        options: {
          description: `Review unified ${row.kind} line`,
          isWholeLine: true,
          className: added ? "line-insert" : "line-delete",
          marginClassName: added ? "gutter-insert" : "gutter-delete",
          lineNumberClassName: added
            ? "review-unified-line-number-added"
            : "review-unified-line-number-deleted",
        },
      },
    ];
  });
}

export function reviewUnifiedLineNumbers(
  rows: readonly ReviewUnifiedDiffRow[],
): (lineNumber: number) => string {
  return (lineNumber) => String(rows[lineNumber - 1]?.authorLine ?? lineNumber);
}
```
Check the exact import paths by opening `reviewUnifiedFilesEditor.ts`'s imports and copying its `Range` and model imports.

- [ ] **Step 2: Use it in both call sites**

`reviewInlineEditorService.ts` `initializeUnifiedEditor`: `lineNumbers: reviewUnifiedLineNumbers(reference.rows)` and `this.diffDecoration.set(reviewUnifiedDiffDecorations(reference.rows))`, deleting the inline `flatMap` block (lines 745-770).

`reviewUnifiedFilesEditor.ts`: same two substitutions for its `lineNumbers` option and the `createDecorationsCollection(...)` argument (lines 83-116).

- [ ] **Step 3: Typecheck, test, and eyeball**

```bash
cd apps/whiteboard-desktop && pnpm typecheck && pnpm test
```
Then run the dev app once (`pnpm app:run` per `README.md`), open a review with an authored peek and the Files tab in unified layout, and confirm added/deleted line tinting and gutter numbers are unchanged in both.

- [ ] **Step 4: Commit**

```bash
git add apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services
git commit -m "Share the unified diff decorations between peeks and the files editor"
```

### Task C2: Compute the peek header counts in the workbench

**Files:**
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewInlineEditorService.ts:712-745, 1130-1155`

**Interfaces:**
- Produces: `setHeader(original, modified, originalLabelUri, modifiedLabelUri, counts?: { additions: number; deletions: number })`. `initializeUnifiedEditor` passes counts derived from `reference.rows` restricted to `reference.windows`. The snippet path passes none.

- [ ] **Step 1: Add the counter next to setHeader**

```ts
function reviewUnifiedWindowCounts(
  rows: readonly ReviewUnifiedDiffRow[],
  windows: readonly WhiteboardPeekWindow[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    if (row.kind === "unchanged") continue;
    const inWindow = windows.some(
      (window) => row.lineNumber >= window.startLine && row.lineNumber <= window.endLine,
    );
    if (!inWindow) continue;
    if (row.kind === "added") additions += 1;
    else deletions += 1;
  }
  return { additions, deletions };
}
```

- [ ] **Step 2: Thread it through**

`setHeader` gains the trailing `counts` parameter and sets `additions: counts?.additions, deletions: counts?.deletions` instead of reading `this.spec.diffStats`. `initializeUnifiedEditor` calls `this.setHeader(..., reviewUnifiedWindowCounts(reference.rows, reference.windows))`. Leave `spec.diffStats` in place for this task; Phase D removes it from the protocol.

- [ ] **Step 3: Verify**

```bash
cd apps/whiteboard-desktop && pnpm typecheck && pnpm test
```
Dev app: an authored peek over a changed range shows non-zero `+n −m` in its header; a peek over an unchanged file shows none.

- [ ] **Step 4: Commit**

```bash
git commit -am "Count peek header additions and deletions from the unified rows"
```

### Task C3: Retire the Monaco multi-diff peek path

**Files:**
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/reviewInlineEditorService.ts`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/whiteboardMultiDiff.ts:39-50`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/services/whiteboardFilesDiffView.ts:198-224`
- Modify: `apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/whiteboardPeek.ts` (multi-diff height helpers, lines ~106-175)
- Modify: `packages/whiteboard-protocol/src/contracts.ts:181-184, 210` (remove `unifiedDiff` from `WhiteboardInlineEditorSpec` and `WhiteboardInlineFindSpec`)
- Modify: `packages/progressive-review/app/src/InlineCodeEditor.tsx`, `CodePeek.tsx`, `whiteboard-components.tsx` (drop the `unifiedDiff` prop end to end)

- [ ] **Step 1: Make `initialize()` unified-or-snippet**

Replace the body of `initialize()` (lines 643-710) so the first branch is unconditional:
```ts
private async initialize(): Promise<void> {
  try {
    const unifiedReference = await this.resources.acquireUnifiedDiff(
      this.spec.path, this.spec.side, this.spec.ranges,
    );
    if (unifiedReference) {
      if (this.disposed) { unifiedReference.dispose(); return; }
      this.initializeUnifiedEditor(unifiedReference);
      return;
    }
    // unchanged file: plain snippet editor, body identical to today's tail
    ...
  } catch (error) {
    if (!this.disposed) this.emitError(error);
  }
}
```
Apply the same collapse to `find()` (lines 289-355): try `acquireUnifiedDiff`, else `acquireSnippet`; delete the middle `resolveDiff` branch.

- [ ] **Step 2: Delete everything only the middle branch used**

In `reviewInlineEditorService.ts`, delete: `initializeMultiDiffEditor` (783-902), `bindActiveDiffEditor` (904-928), `layoutMultiDiffToContent` (1003-1023), `applyMultiDiffScrollRange` (1024-1057), `multiDiffBodyHeight`, `multiDiffWindowContentHeight`, `cappedMultiDiffWindowContentHeight` (1058-1129), `updateDiffDecorations` (1260-1298), the `InlineDiffModel` interface (91-96), `inlineDiffEditorOptions` and `reviewInlineDiffEditorContributions` (1452-1482), the `scrollRange` observable field (437-449), and the fields `multiDiffEditor`/`diffModel`/similar that no longer have writers. Remove the now-unused imports (`MultiDiffEditorWidget`, `MultiDiffEditorInput`, `MultiDiffEditorItem`, `computeMultiDiffEditorOptions`, `IDiffEditorOptions`, `ElementSizeObserver`). Let the typechecker drive the list; after each deletion run `pnpm typecheck` and delete what it reports as unused-or-missing until it is clean.

`whiteboardMultiDiff.ts:39-50`: remove the `scrollRange` constructor parameter. `whiteboardFilesDiffView.ts:198-224` and the remaining constructor call in `reviewInlineEditorService.ts:499-507` drop the corresponding positional argument. (Converting the six positional parameters into an options object is worthwhile here, since you are touching all three call sites; do it if it stays within this task.)

`whiteboardPeek.ts`: delete every export whose only importer was a deleted function (`git grep -n <name> apps/whiteboard-desktop/code-oss/src/vs/review` for each export in the file). `whiteboardPeekDiffWindows` and `whiteboardPeekLineMappings` stay: `acquireUnifiedDiff` still uses them through `resolveDiff`. Make `resolveDiff` private on `ReviewCodeResourceService` if `git grep` shows no other caller, and drop it from the `IReviewCodeResourceService` interface at lines 145-150.

- [ ] **Step 3: Remove `unifiedDiff` from the protocol and the app**

`contracts.ts`: delete the `unifiedDiff?: boolean` member and its doc comment from `WhiteboardInlineEditorSpec` (183-184) and `WhiteboardInlineFindSpec` (210). Run `pnpm --filter @dev.fast/whiteboard-desktop run protocol:sync`. Then in the app delete the prop from `InlineCodeEditor` (destructuring, `find` spec, `create` spec, effect deps), from `CodePeekCard`/`CodePeekView`/`WhiteboardCodePeek`/`CodePeekGroup` in `CodePeek.tsx`, and from `WhiteboardPeekContentView` in `whiteboard-components.tsx`. `InlineCodeEditor.test.tsx` and `CodePeek.test.tsx` will have `unifiedDiff` in a few expectations; delete those keys.

- [ ] **Step 4: Verify, including a hands-on pass**

```bash
cd apps/whiteboard-desktop && pnpm typecheck && pnpm test
cd ../../packages/progressive-review && pnpm typecheck && pnpm vitest run --config vitest.config.ts app/src/InlineCodeEditor.test.tsx app/src/CodePeek.test.tsx app/src/review-components.test.tsx
```
Dev app, both diff layouts toggled: authored peek, tour stop, software-map inspector peek (this is the one that changes), find-in-review hitting text inside a collapsed peek, Open file from the peek header, go-to-definition on a symbol inside a peek (exercises `reviewUnifiedDefinition.ts`, which must keep working because it is why the unified renderer survives).

- [ ] **Step 5: Commit and open PR 3**

```bash
git add -A apps/whiteboard-desktop/code-oss/src/vs/review packages/whiteboard-protocol/src packages/progressive-review/app/src
git commit -m "Render every inline peek through the unified diff editor"
cd ../.. && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
git push -u origin chore/ui-simplification-c
gh pr create --base chore/ui-simplification-b --draft --title "Collapse the inline peek renderers to the unified editor" --body "<list the deleted functions; state the two behavior changes from the phase header>"
```

---

## Phase D — Delete client-side code-peek resolution (PR 4)

Branch: `chore/ui-simplification-d` from `chore/ui-simplification-c`. After Phase C the workbench supplies everything a peek shows. The only remaining consumers of a resolution were the header counts (now workbench-computed) and a truthiness gate. **Behavior change:** the `review_peek_resolved` and `review_peek_resolve_failed` telemetry events stop being sent; a missing source now surfaces as the existing "Inline preview unavailable" state from the workbench editor.

**Success criteria (Phase D):**

| Gate | Pass condition |
|---|---|
| 1 | Full suite green except baseline. `src/ui-telemetry-events.test.ts` (the privacy inventory) passes with the two events removed. `desktop-entry.test.tsx` passes with the resolve-stub cases removed. `pnpm --filter @dev.fast/review run check:tutorial` passes (publish-time resolution is untouched and the tutorial still publishes). |
| 2 | `diff phase-c.json phase-d.json` may contain **only**: `peekResolveRequests` → `0` for every review (baseline was non-zero), `strayAttributes.authoredPeekRequests` → `null`, and `peekErrors` → `[]` where the baseline listed a resolve-side error text (a workbench-side error shows in `editors[*].error` instead and must match the baseline's set of unavailable files). **Must be unchanged:** every `editors[*]` field including `additions`/`deletions`, `toc`, `sections`, `findCount`, `widgetCount`, `modelCount`, `consoleErrors` empty. `openMs` for the peek-heavy review must be **lower** than phase C (median of three runs); it was paying one round trip per anchor. |
| 3 | (a) Open a review whose worktree file was deleted after publish (delete one under `/tmp/rh/...` base checkout to simulate): the peek shows "Inline preview unavailable", the rest of the document renders, no console error. (b) Open a legacy review from the fixtures corpus (`pnpm --filter @dev.fast/review run test:legacy-corpus` with `WHITEBOARD_LEGACY_CORPUS` set, if the corpus is available locally): passes. (c) Fresh `review scaffold` + `review publish` in a temporary repo, then open it: peeks render with counts. (d) Network panel (CDP `page.on("request")` in the snapshot script already does this): zero requests to `/code-peek/resolve` across all three reviews. |

### Task D1: Render authored peeks without a resolution

**Files:**
- Modify: `packages/progressive-review/app/src/CodePeek.tsx`
- Modify: `packages/progressive-review/app/src/authored-code-surface.tsx:19-21, 47-59`
- Modify: `packages/progressive-review/app/src/whiteboard-panel-model.ts:10` (type only, unchanged shape)
- Modify: `packages/progressive-review/app/src/CodePeek.test.tsx`, `software-map/SoftwareMap.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ValidatedCodePeekInput { readonly [validatedCodePeekInput]: true; readonly props: CodePeekProps }
  export function validatedCodePeekInputFromRef(ref: CodePeekRef): ValidatedCodePeekInput;   // { props: ref.props }
  export function codePeekSubject(input: ValidatedCodePeekInput): CodePeekSubject | undefined; // from props alone
  export function CodePeekCard(props: { input; active?; heightMode?; onNativeFocus? }): JSX.Element;
  export function CodePeekGroup(props: { peeks: readonly CodePeekProps[]; collapsed?: boolean }): JSX.Element;
  ```
  `CodePeek` (inspector) and `CodePeekView` collapse to `CodePeekCard`. Deleted: `CodePeekLoadState`, `codePeekLoadState`, `useCodePeekResolution`, `CodePeekResolutionReporter`, `CodePeekResolveResult`, `CodePeekResolveInput`, `codePeekDiffCountsForSubject`, `isCodePeekNoMatch`, `fetchCodePeekResult`, `fetchCodePeekResultWithRetry`, `isRetryableCodePeekError`, `delay`, and the `resolution`/`status`/`error`/`diffStats` props.

- [ ] **Step 1: Rewrite CodePeek.tsx**

Keep: the brand symbol, `CodePeekProps`, `CodePeekGraph`, `CodePeekSubject`, `codePeekRootFromProps`, `codePeekRangeTitle`, `codePeekPropsKey`, `mergedCodePeekRanges`, `captureUiEvent` import only if `peek_opened` is still fired here (it is not; drop the import). The new shapes:

```tsx
export function WhiteboardCodePeek({ anchor }: WhiteboardCodePeekProps) {
  const input = useMemo(() => validatedCodePeekInputFromRef(anchor.peek), [anchor.peek]);
  return <CodePeekCard input={input} />;
}

export function CodePeek(props: CodePeekProps) {
  const input = useMemo<ValidatedCodePeekInput>(
    () => ({ [validatedCodePeekInput]: true, props: validateCodePeekProps(props) }),
    [props],
  );
  return <CodePeekCard input={input} heightMode="content" />;
}

export function CodePeekCard({ input, active = false, heightMode = "capped", onNativeFocus }: {
  input: ValidatedCodePeekInput; active?: boolean;
  heightMode?: WhiteboardInlineEditorHeightMode; onNativeFocus?: () => void;
}) {
  const session = useWhiteboardSession();
  const subject = useMemo(() => codePeekSubject(input), [input]);
  const onNativeFocusRef = useRef(onNativeFocus);
  onNativeFocusRef.current = onNativeFocus;
  if (!subject) {
    return (
      <section className="code-peek" data-code-rendering="inline-editor">
        <div className="peek-status">No code location is attached here yet.</div>
      </section>
    );
  }
  const graph = input.props.graph ?? "head";
  return (
    <section className="code-peek" data-code-rendering="inline-editor">
      <InlineCodeEditor
        path={subject.file}
        title={subject.title}
        side={graph}
        ranges={[{ startLine: subject.line, endLine: subject.endLine }]}
        heightMode={heightMode}
        active={active}
        onFocus={() => onNativeFocusRef.current?.()}
        onOpen={() => session.surface.revealAnchor(subject.file, { fromLine: subject.line, toLine: subject.endLine }, graph)}
      />
    </section>
  );
}

export function codePeekSubject(input: ValidatedCodePeekInput): CodePeekSubject | undefined {
  const root = codePeekRootFromProps(input.props);
  if (!root) return undefined;
  return { title: codePeekRangeTitle(root.file, root.fromLine, root.toLine), file: root.file, line: root.fromLine, endLine: root.toLine };
}
```
`CodePeekGroup` loses its state map and reporter children; group synchronously:
```tsx
export function CodePeekGroup({ peeks, collapsed = false }: { peeks: readonly CodePeekProps[]; collapsed?: boolean }) {
  const session = useWhiteboardSession();
  const groups = useMemo(() => groupedCodePeeks(peeks), [peeks]);
  return (
    <>
      {groups.map((group) => {
        const primaryRange = group.ranges[0]!;
        return (
          <section key={group.key} className="code-peek" data-code-rendering="inline-editor">
            <InlineCodeEditor path={group.file} title={group.file} side={group.graph} ranges={group.ranges}
              heightMode="content" active={false} collapsed={collapsed}
              onOpen={() => session.surface.revealAnchor(group.file, { fromLine: primaryRange.startLine, toLine: primaryRange.endLine }, primaryRange.side ?? group.graph)} />
          </section>
        );
      })}
    </>
  );
}
```
where `groupedCodePeeks` is `resolvedCodePeekGroups` with the `states` parameter, the `diffStats` accumulation, and `hasDiffStats` removed, and `codePeekSubject(entry.input)` called without a resolution.

- [ ] **Step 2: Simplify AuthoredCodeSurface**

The first line number is the authored `fromLine`:
```tsx
const firstLine = anchor.peek?.props.fromLine ?? 1;
```
Delete `resolvedSourceFirstLine`.

- [ ] **Step 3: Update the tests**

`CodePeek.test.tsx`: delete the tests that stub `/code-peek/resolve` and assert on "Resolving code location...", retry behavior, or `peek_resolved` telemetry. Keep the tests that assert the editor is created with the right `path`/`ranges`/`side`. `code-peek-loading.test.ts`: delete the file. `SoftwareMap.test.ts`: remove any `/code-peek/resolve` stub; grouping is now synchronous, so drop the `await` that waited for resolution.
```bash
git rm packages/progressive-review/app/src/code-peek-loading.test.ts
cd packages/progressive-review && pnpm vitest run --config vitest.config.ts app/src/CodePeek.test.tsx app/src/software-map/SoftwareMap.test.ts app/src/review-components.test.tsx app/src/side-peek-validation.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add -A packages/progressive-review/app/src
git commit -m "Render code peeks straight from their authored range"
```

### Task D2: Delete load-time document preparation

**Files:**
- Delete: `packages/progressive-review/app/src/review-document-prepare.ts`, `review-document-prepare.test.ts`, `code-peek-resolution.ts`, `code-peek-resolution.test.ts`
- Modify: `packages/progressive-review/app/src/host/whiteboard-session.tsx:19-23, 35, 71`
- Modify: `packages/progressive-review/app/src/desktop-entry.tsx:24, 90-104, 171-178, 540`
- Modify: `packages/progressive-review/src/ui-telemetry-events.ts:257-263` and `src/ui-telemetry-events.test.ts`
- Modify: `apps/whiteboard-desktop/scripts/native-authoring-e2e.mjs:584, 612` and the assertion between them

- [ ] **Step 1: Hydrate directly in desktop-entry**

Replace the `documentState` loader body:
```tsx
const documentState = useSettledLoad(documentBundle, (load): WhiteboardDocumentAppState => {
  if (load.state !== "ready") return load;
  const session = sessionRef.current;
  let document = session.documents.get(load.contentHash);
  if (!document) {
    document = hydrateReviewDocument(load);
    session.documents.set(load.contentHash, document);
  }
  return { state: "ready", document };
});
```
Delete the `purpose === "validation"` loop that threw when `anchor.peek.resolution` was null; publish already fails a document whose peek does not resolve (`whiteboard-publication-audit.ts:128-186`), so the mount-time check was redundant. Delete the diagnostics effect at 171-178 and the reset at 540. If `useSettledLoad` requires an async callback, keep `async` and return the same value.

`whiteboard-session.tsx`: `documents: Map<string, HydratedReviewDocument>`; delete `ReviewDocumentCacheEntry`.

- [ ] **Step 2: Delete the modules and the telemetry events**

```bash
git rm packages/progressive-review/app/src/review-document-prepare.ts packages/progressive-review/app/src/review-document-prepare.test.ts packages/progressive-review/app/src/code-peek-resolution.ts packages/progressive-review/app/src/code-peek-resolution.test.ts
```
In `ui-telemetry-events.ts` delete the `peek_resolve_failed` and `peek_resolved` entries and, if now unused, `PEEK_ROOT_KIND`. Run `pnpm vitest run --config vitest.config.ts src/ui-telemetry-events.test.ts` and remove the two events from whatever inventory it asserts.

In `native-authoring-e2e.mjs`, the `page.route("**/code-peek/resolve*", failBasePeek)` block simulated a failed base peek. Delete the route, the unroute, and the assertion that depended on it; add a one-line comment that a missing source now surfaces through the workbench editor's `onDidError` path, which `InlineCodeEditor.test.tsx` covers.

- [ ] **Step 3: Verify**

```bash
cd packages/progressive-review && pnpm typecheck && pnpm vitest run --config vitest.config.ts app/src/desktop-entry.test.tsx app/src/review-document-hydrate.test.ts src/ui-telemetry-events.test.ts src/error-telemetry.test.ts
```
`desktop-entry.test.tsx` has tests that stub the resolve route or assert `reviewAuthoredCodePeekRequestCount`; delete those cases.

- [ ] **Step 4: Commit**

```bash
git add -A packages/progressive-review apps/whiteboard-desktop/scripts
git commit -m "Stop re-resolving code peeks when a document loads"
```

### Task D3: Delete the resolve route and its diff slicing

**Files:**
- Modify: `packages/progressive-review/src/server/review-api.ts:291, 650-684, 1067-1159` and the `parseCodePeekGraph`/`parseCodePeekRoot`/`CODE_PEEK_DIFF_CONTEXT_LINES` helpers if only they used them
- Modify: `packages/progressive-review/src/codepeek-symbol-diff.ts` and its test
- Modify: `packages/progressive-review/src/authoring.ts:132-152` (`CodePeekDiffFile`, `CodePeekDiffPayload`, `CodePeekResolution.diff`)
- Modify: `packages/progressive-review/src/source-code-types.ts` (`SourceLineComment`)

- [ ] **Step 1: Delete the route and handler**

Remove the `app.post("/code-peek/resolve", ...)` registration and `codePeekResolve`, then `resolveCodePeekDiff`, `resolveCodePeekDiffFiles`, `serializeCodePeekDiffFile`, `codePeekDiffRangeFiles`. For each helper they called (`parseCodePeekGraph`, `parseCodePeekRoot`, `CODE_PEEK_DIFF_CONTEXT_LINES`, `CodePeekDiffResponse`), `git grep -nw` it and delete when unreferenced. `parseCodePeekIncludeDiff` and `parseCodePeekIncludeDiffSummary` in the same file already have zero callers today; delete them here too.

- [ ] **Step 2: Prune codepeek-symbol-diff.ts**

```bash
git grep -nw "sliceReviewDiffFileToCodePeekRanges\|codePeekRootSourceRanges\|mergeCodePeekDiffRanges" -- packages ':!*/dist/*' ':!*.test.*'
```
If the only remaining callers are the deleted route, delete the file and its test. If `software-map` code still imports something from it, keep only that export.

- [ ] **Step 3: Narrow the resolution type**

In `authoring.ts`, `CodePeekResolution` becomes `{ snapshot: SourceSnapshot }`; delete `CodePeekDiffFile` and `CodePeekDiffPayload`. Delete `SourceLineComment` from `source-code-types.ts`. Publish validation (`codePeekResolutionHasSource`) only reads `snapshot`, so nothing else moves.

- [ ] **Step 4: Full gate, commit, open PR 4**

```bash
cd packages/progressive-review && pnpm typecheck && pnpm test
cd ../.. && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
git add -A packages/progressive-review
git commit -m "Remove the code peek resolve route"
git push -u origin chore/ui-simplification-d
gh pr create --base chore/ui-simplification-c --draft --title "Delete client-side code peek resolution" --body "<list deleted modules; state the telemetry events that stop; state that per-peek load-time network requests are gone>"
```

---

## Phase E — Record what stays (no code)

**Success criteria (whole plan):** with all four PRs merged into `chore/remove-comments-tui`, re-run Task 0 against the merged tip and diff against `baseline.json`. The union of the four phases' allowed deltas is the complete expected diff; anything else is a regression that slipped through a phase gate. Then delete `/tmp/rh`.

Add a section to PR 4's description, or a short note in `docs/`, listing the candidates that were examined and deliberately left alone, so the next person does not re-audit them:

- **createElement in the document renderer.** Tag and component identity come from data; JSX gains nothing. The four gratuitous `createElement` sites (`agent-markdown.tsx:146,160,261`, `whiteboard-view-state.ts:103`) are cosmetic and can be converted whenever those files are next edited.
- **Diff entry points.** The Diff tab is 40 lines around `openEditor`; the Files view and commit-scoped Files view are one implementation. Nothing to merge.
- **Per-editor bridge handles.** They carry height, error, find, and lifetime coupling that a canvas-level mount API would have to reinvent.
- **`WhiteboardStateContext` / `WhiteboardActionsContext` split.** Load-bearing for re-render isolation of open peeks; merging would regress.
- **Duplicated height estimator** (`InlineCodeEditor.tsx:291-307` vs `reviewInlineEditorService.ts:1364-1382`). The React copy sizes the pre-mount placeholder, which the workbench cannot do; the protocol generator does not carry functions across, so sharing would need a new mechanism. Align the `Math.max(1, …)` clamp if either is touched.
- **Scroll-restore `ResizeObserver` over every descendant** (`whiteboard-view-state.ts:369-371`). Deliberate; do not narrow without a repro.
- **`domReadOnly: false`** on the read-only peek editor (`reviewInlineEditorService.ts:1421`). Possibly comment-era; needs an accessibility check before flipping.
- **Reload duplicates diff content** (pre-existing, noted in PR #258). Suspect `reviewUnifiedDiff.ts:66-70` emitting base and head remainders when line mappings misalign, driven by a server-cached patch. Not in scope here; instrument row count against base plus head length at `reviewCodeResourceService.ts:460` to confirm.
- **README hero image and the four redesign PNGs** under `packages/progressive-review/docs/review-actions-redesign/`. Out of scope for this plan by request; the hero still shows the Ask/Threads UI and needs a fresh capture separately.

---

## Self-review

- **Coverage:** every audit item is either a task (A1–D3) or an explicit "left alone" entry in Phase E.
- **Ordering:** C (workbench counts) precedes D (drop resolution) so the header never loses its counts. B is independent of C/D and could be reordered if a reviewer prefers. A is prerequisite for nothing but is smallest and safest first.
- **Type consistency:** `WhiteboardTocEntry` is defined once (B1) and consumed by B2; `WhiteboardSectionSummary` defined once (B3); `ValidatedCodePeekInput` narrows in D1 and every later reference uses the narrowed shape; `setHeader`'s `counts` parameter (C2) matches `reviewUnifiedWindowCounts`'s return.
- **Placeholders:** none. Where a step says "let the typechecker drive the list" (C3 step 2) the named functions to delete are enumerated first; the typechecker only confirms the imports.
