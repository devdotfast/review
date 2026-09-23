# PR 0: Quick wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the zero-behaviour-change cleanups from the audit's §3 that survive PRs 1–5 (items inside files those PRs delete are skipped), verified on the #296 branch on 2026-09-16.

**Architecture:** Mechanical: delete dead files and exports, collapse duplicate aliases, make the test lanes resolve workspace packages from source, and drop package export subpaths nothing imports. Each task is one commit and independently revertable.

**Tech Stack:** pnpm workspace, tsdown, Vitest, TypeScript.

**Spec:** audit §3; index `2026-09-16-mdx-removal-index.md`.

## Global Constraints

- Base: `origin/main` (or #296; nothing here conflicts). `git worktree add -b chore/mdx-0-quick-wins ../review-mdx-0 origin/main && pnpm install`.
- Skipped on purpose because a later PR deletes the file: `authoring.ts` code-peek leftovers (PR 3), `publish-stage.ts` `readPresentedReviewRecord`, `runtime.ts` `activeReviewMdxPath` (PR 3), `review-derived-paths.ts` / `review-checkout-paths.ts` folding (PR 5), `review-session-mode.ts` (PR 1/5), `review-attention.ts` `writeReviewRecord` (PR 5), `review-document-data.ts` dead schemas (PR 5).
- Not a quick win after verification: `packages/trace-core/src/review-agent-traces.ts` has 11 production importers (the "kept for one release" comment is stale; migrating 14 import sites is its own PR). `src/server/http-json.ts` is a real leaf module, not a duplicate of `hono-http.ts`. `pino-pretty`'s branch is test-only but is a production dependency: move it, don't delete it.
- `semver` cannot be removed: `apps/review-desktop/scripts/stage-review-runtime.mjs:18` resolves it from the deployed runtime.

---

### Task 1: Dead files and dead re-exports

**Files:**
- Delete: `packages/review/src/server/desktop-paths.ts`, `packages/review/src/map-cli-entry.ts`
- Modify: `packages/review/src/review-api/agent-client.ts:5`, `packages/review/package.json:68`, `packages/review/app/src/ReviewTraceView.tsx:17-49`, `packages/trace-core/src/trace-repository-target.ts:27,29`, `packages/trace-protocol/src/store-api.ts:67`

- [ ] **Step 1:** `agent-client.ts:5` imports `reviewDesktopDiscoveryPath` from `../server/desktop-paths.js` → change to `../review-home-paths.js`. `git rm src/server/desktop-paths.ts`.
- [ ] **Step 2:** `git rm src/map-cli-entry.ts`; delete the `"map"` script (`package.json:68`). `review map` is the same entry.
- [ ] **Step 3:** Delete `ReviewTraceView.tsx:17-49` (33 re-exported symbols; consumers import only `ReviewTraceView` and `TraceSelection` at `App.tsx:81`).
- [ ] **Step 4:** Delete `trace-repository-target.ts:27` and `:29` (every consumer imports those four symbols from `./trace-repo` directly). Delete `store-api.ts:67` `findStoreQuerySchema` (0 references).
- [ ] **Step 5:** `pnpm typecheck` across the workspace; `pnpm vitest run --config vitest.config.ts src/review-api/agent-client.test.ts app/src/ReviewTraceView.browser.test.tsx` in `packages/review`. Commit: "Delete dead shims and re-exports".

---

### Task 2: Duplicate aliases and zero-reference exports

**Files:**
- Modify: `packages/review/src/review-app.ts:102`, `review-app.test.ts`, `cli.test.ts:27`; `app/src/use-agent-trace.ts:29`, `app/src/ReviewTraceView.tsx:13,87,121,408`; `packages/trace-core/src/trace-capture-cli.ts:274`, `trace-read-cli.ts:449`, `index.ts:34,46`, `packages/review/src/trace-cli.ts:26,37`, `trace-cli.test.ts:24,27,186,462,556,581`
- Modify (delete exports): `startup-trace.ts` (`flushTrace`, `SpanHandle`, `spanSync`, `TRACE_DIR_ENV`, `TRACE_FILE_ENV`, `TraceSpanRecord`), `telemetry-config.ts` (`LEGACY_APP_TELEMETRY_CONFIG_RELATIVE_PATH`, `TELEMETRY_CONFIG_RELATIVE_PATH`), `telemetry-debug-sink.ts` (`REVIEW_TELEMETRY_DEBUG_ENV`, `REVIEW_TELEMETRY_DEBUG_PREFIX` — inline them), `review-preferences.ts` (`DEFAULT_REVIEW_PREFERENCES`, `ReviewPreferences`, `reviewPreferencesPath` — un-export), `review-app-picker.ts` (`relativeTime`), `software-map-health.ts` (`listCommitTreeFiles`, `PublishSoftwareMaps`, `SoftwareMapSourceCheck` — un-export), `software-map-diff-counts.ts` (the 13 unused exports — un-export the types, delete `softwareMapCoverageClaimMatchesLine` and `softwareMapLineInRanges` if unused internally), `software-map-artifact.ts` (`materializeSoftwareMapAtRefSync`, `readSoftwareMapSourceForRefSync` and their two test cases; `SoftwareMapModelFile`, `SoftwareMapSourceReadResult`), `review-bundled-tools.ts` (`ensureBundledTool`, `EnsureBundledToolInput`, `EnsureBundledToolResult` — un-export or delete if internal-only)

- [ ] **Step 1:** Aliases: delete `runReviewApp` (`review-app.ts:102`) and use `runReviewAppPick` in the two tests. Delete `makeTraceKey` (`use-agent-trace.ts:29`) and import `makeAgentTraceKey` in `ReviewTraceView.tsx`. Delete `runTraceDoctor` and `runTraceLookupBlame` (trace-core `:274`, `:449`), their `index.ts` and `trace-cli.ts` re-exports, and use `runTraceStatus`/`runTraceBlame` in `trace-cli.test.ts`.
- [ ] **Step 2:** Zero-reference exports: for each name run `git grep -nw <name> -- packages apps` and confirm the only hit is the declaration, then delete or un-export as listed.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint`; run `review-app.test.ts`, `cli.test.ts`, `trace-cli.test.ts`, `software-map-artifact.test.ts`. Commit: "Remove duplicate aliases and unreferenced exports".

---

### Task 3: Test lanes resolve workspace packages from source

**Files:**
- Modify: `packages/review/vitest.config.ts:17-34,54-76`, `packages/review/package.json:61-64`, `packages/trace-core/package.json:20,22`

- [ ] **Step 1:** In `packages/review/vitest.config.ts` hoist `resolve: { alias }` to the top-level `defineConfig` (today only the `browser` project has it at `:71`, which is why the node lanes need `dist`). Keep `dedupe` on the browser project.
- [ ] **Step 2:** `pretypecheck`, `pretest`, `pretest:browser`, `pretest:node` become `pnpm run ensure:tutorial-assets` (drop `build:workspace-deps`; `tsconfig.base.json:16-20` maps `@dev.fast/*` to `src`). Keep `prebuild`. In `packages/trace-core/package.json` delete `pretest` (`:20`) and `pretypecheck` (`:22`); its vitest config already aliases at the top level.
- [ ] **Step 3:** Prove it from a clean state: `rm -rf packages/*/dist && pnpm --filter @dev.fast/review typecheck && cd packages/review && pnpm test:node && pnpm test:browser && cd ../trace-core && pnpm test`. Expected: green without any `dist`. Commit: "Run tests and typecheck against workspace sources".

---

### Task 4: Dependencies and export map

**Files:**
- Modify: `packages/review/package.json:21-42,87,119,125,129`, `packages/review/tsdown.config.ts:39,41,43,44,45`, `packages/review/vitest.config.ts:30`, `packages/review-protocol/package.json:16-20`, `apps/review-desktop/package.json:25`

- [ ] **Step 1:** Delete `@types/mdx` (`:129`, 0 importers; PR 3 deletes the rest of the MDX deps). Move `pino-pretty` to `devDependencies` (its branch is reached only from `review-logger.test.ts:29-31`). Delete `@dev.fast/trace-protocol` (`:125`) together with the alias at `vitest.config.ts:30` only if `pnpm test:node` still resolves `@dev.fast/trace-core`'s re-exports under `nodeLinker: hoisted`; otherwise keep both and note why in a comment.
- [ ] **Step 2:** Exports map: delete `./runtime`, `./desktop-server`, `./software-map`, `./software-map-topology-diff` (0 importers; the desktop stages `dist/cli.js` and `dist/server/desktop-host.js` by path in `stage-review-runtime.mjs:37-39`) and their tsdown entries (`:39,41,43,45`). Keep `cli`, `server/desktop-host`, `software-map-model`, `authoring` (PR 3 decides). Delete the `tolerant-software-map-model` tsdown entry (`:44`; the file is shipped as source, `package-paths.ts:10`, never imported as a module). Delete `packages/review-protocol/package.json:16-20` `./bug-report` subpath (0 importers). Add a comment above `apps/review-desktop/package.json:25` that the `@dev.fast/review-protocol` declaration exists for workspace build ordering only.
- [ ] **Step 3:** `pnpm install && pnpm --filter @dev.fast/review build && pnpm --filter @dev.fast/review-desktop typecheck`; run `node --test apps/review-desktop/scripts/packaged-runtime.test.mjs`. Commit: "Trim unused dependencies and package exports".

---

### Task 5: Desktop build duplication

**Files:**
- Modify: `apps/review-desktop/scripts/run.sh:63,81-91`, `apps/review-desktop/scripts/build.sh:37-45,115-125`, `apps/review-desktop/scripts/curated-extensions.test.mjs:361`

- [ ] **Step 1:** `run.sh:63` re-runs `curated-extensions.mjs` after `build.sh:41-42` already did in `pnpm dev`. Guard it with the same `.stamp` the client lane uses (`build.sh:78-100`) or delete the `run.sh` call and update `curated-extensions.test.mjs:361`, which asserts `run.sh` contains the invocation.
- [ ] **Step 2:** Steps 13–16 (tsdown, vite canvas, tutorial assets, copy-canvas) exist in `build.sh:117-125` (unconditional unless `DEV_FAST_ACTIVE=1`) and `run.sh:65-93` (gated by `needs_rebuild`). Make `build.sh` source `freshness.sh` and call the same gated block, so the steps are written once; the tutorial rule's `find … -newer` in `run.sh:82-91` becomes a `needs_rebuild` call (PR 2 changes its inputs to `git-stub/HEAD`; coordinate).
- [ ] **Step 3:** `pnpm dev` twice in a row; the second run must skip all four steps. Commit: "Deduplicate the desktop build steps".

---

### Task 6: PR

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check` at the root; both review lanes; `git diff --stat origin/main | tail -1`. PR title "Quick wins from the simplification audit"; body lists each task as a bullet and names the items deferred to PRs 1–5.

## Self-review

- §3 items covered: deps (`@types/mdx`, `pino-pretty`, `@dev.fast/trace-protocol`, exports map, `./bug-report`, tolerant model entry, desktop protocol declaration), dead files (desktop-paths, map-cli-entry, ReviewTraceView block, trace-repository-target re-exports), aliases (all six), zero-reference exports (all files the audit named except those deferred), `pretest`/`pretypecheck`, desktop build duplication.
- Deferred with reasons in Global Constraints: `review-agent-traces.ts` barrel, `trace-storage-cli.ts` move to trace-core, `agent-fff.ts` corpus root (belongs with the barrel migration), `zustand` inlining and `@tanstack/react-table` (need the ListView decision from audit §2c), `semver`.
