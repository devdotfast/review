# PR 1: Stop writing legacy reviews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every path that creates or rewrites a legacy MDX review (the CLI verbs, the three `*-ready` routes, the off-screen publish-gate mount, the repair ladder, and pinned-worktree preparation) while leaving the legacy read path and the importer intact.

**Architecture:** After #296 every review that `review publish` produced is imported into the SQLite store; the JSON API (`review api`, MCP) is the only supported authoring route (`skills/dev-review/SKILL.md:12,24,35`). So the writers are deleted, not replaced. `mountPublishedDocument` and `validateCanvasMount` were a smoke test for executable MDX; no static check replaces them because there is no MDX publish left. What stays: `registerSerialized`, `withReviewLock`, `materializePublishRevision`, `sealReviewCandidate`, `review-vcs.ts` (the tutorial service still seals a legacy review until PR 2; `openHistoricalReviewSession` still registers unpromoted sessions).

**Tech Stack:** TypeScript, Hono, zod 4, Commander, Vitest, Playwright via `native-authoring-e2e.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-15-post-merge-simplification-audit.md` §1a, §2a, §2e; index `2026-09-16-mdx-removal-index.md`.

## Global Constraints

- Base: `feat/block-validators` (the user's block-definitions branch, local, unpushed; head `52caf7fec` on 2026-09-16). Worktree `/Users/aiansiti/workable/review-mdx-1`, branch `chore/mdx-1-legacy-writers`. Never edit inside `../review-block-validators`. When `feat/block-validators` moves, `git rebase -X theirs feat/block-validators`; conflicts land in files this PR deletes and resolve as "take the deletion".
- The block-definitions plan (Tasks 9–10 there) removes the off-screen mount from the protocol, the Electron shell and the canvas entry, and trims `mountPublishedDocument`/`mountPublishedSoftwareMap` to register-and-promote. This PR must not touch `packages/review-protocol`, `apps/review-desktop/code-oss`, or `app/src/desktop-entry.tsx` for the mount; it deletes the two server functions whole (their callers go), which supersedes the trim. Task 1 below is verification only.
- Line numbers below are from `feat/legacy-review-import` at `884e55a8a`; the base adds only `#299`'s edits to `document.ts`/`source.ts`, block fixtures and plan docs, so `desktop-server.ts`, `cli-runner.ts` and the deleted modules are unchanged. Re-locate by symbol if a line moved.
- Keep: `publish-stage.ts`, `review-vcs.ts`, `review-bundle.ts`, `review-sealed-document.ts`, `review-publish-evaluate.ts`, `review-head-checkout.ts` (`ensureReviewPinnedCheckout`, `ensureReviewCheckouts` open legacy reviews), `review-mutation-lock.ts`, `registerSerialized`, `withReviewLock`, `reapDismissedReviews`, `tutorial-service.ts`, `stored-review-migration.ts`, `isomorphic-git`, `createReviewDir`, `sealReviewCandidate`, `materializeReviewRevision`.
- Keep `review info`, `review app`, `review migrate`, `review trace`, `review map open|check|prune|push|fetch`, `review install`, `review api`, `review mcp`.
- Every deleted module takes its `.test.ts` with it. Every trimmed test keeps its remaining cases untouched.
- Line numbers below are from `feat/legacy-review-import` at `884e55a8a`; re-locate by symbol if the base moved.
- Run `pnpm --filter @dev.fast/review build:tutorial-assets` once in the worktree before the first test run.

## File Structure

Deleted (packages/review/src unless noted):
`review-publish.ts`, `review-map-publish.ts`, `review-repair.ts`, `review-repair-preparation.ts`, `review-repair-state.ts`, `review-publication-preparation.ts`, `review-publication-staging.ts`, `review-tree-fingerprint.ts`, `review-scaffold.ts`, `review-rebind.ts`, `review-internal-test.ts`, `server/review-repair-promotion.ts`, plus tests `review-map-publish.test.ts`, `review-repair.test.ts`, `review-repair-state.test.ts`, `review-publication-staging.test.ts`, `review-prepare.test.ts`, `server/desktop-server-repair.test.ts`, `server/review-repair-promotion.test.ts`, `review-scope-errors.test.ts`.

Trimmed: `cli-runner.ts`, `cli.ts`, `map-cli.ts`, `publish-preparation.ts` (→ only `resolvePublishReview`), `review-worktree-target.ts`, `review-prepare.ts`, `review-artifact-promotion.ts`, `review-home.ts` (`updateReviewPins`, `findReviewForRepair`), `review-telemetry.ts`, `server/desktop-server.ts`, `server/review-session-mode.ts`, `app/src/desktop-entry.tsx`, `packages/review-protocol/src/{contracts,index}.ts`, `apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts`, `apps/review-desktop/scripts/native-authoring-e2e.mjs`, docs.

---

### Task 1: Verify the mount is gone and sweep leftovers

**Files:**
- Verify only, unless the grep finds hits: `packages/review/app/src/desktop-entry.tsx`, `apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts`, `packages/review-protocol/src/contracts.ts`

- [ ] **Step 1: Grep for the mount**

```bash
git grep -n "validateCanvasMount\|validateSessionMount\|resolveValidationSession\|settlementSession\|purpose: \"validation\"\|PublishMountTiming\|MountVerbResultSchema\|mountStepTimings" -- packages apps
```

Expected on this base: hits remain (the user's block-definitions branch has not reached its Tasks 9–10 yet). That is fine: leave them. This PR deletes only the server-side callers (Task 2); the verb, `settlementSession` and `validateSessionMount` are removed by the block-definitions branch and disappear from this PR on rebase.

- [ ] **Step 2: Nothing to commit**

Task 2 deletes `mountPublishedDocument` and `mountPublishedSoftwareMap` whole together with their callers, so the block-definitions branch's trim of those functions has nothing left to conflict with.

*(Original Task 1, kept for the fallback where PR 1 precedes the block-definitions PR: delete `desktop-entry.browser.test.tsx:642-837`; in `desktop-entry.tsx` drop the `purpose` prop, `settlementSession`, the validation readiness gate and the validation branch of `reportLoadFailure`; in `contracts.ts` delete the `validateCanvasMount` verb and the `purpose` field; in `reviewCanvasPart.ts` delete `validateSessionMount`, `resolveValidationSession` and the dispatch special-case; rebuild the protocol and `protocol:sync`.)*

---

### Task 2: Delete the ready routes, mount/promote functions and the repair server side

**Files:**
- Modify: `packages/review/src/server/desktop-server.ts`
- Delete: `packages/review/src/server/review-repair-promotion.ts`, `server/review-repair-promotion.test.ts`, `server/desktop-server-repair.test.ts`, `src/review-repair-state.ts`, `src/review-repair-state.test.ts`
- Modify: `packages/review/src/server/review-session-mode.ts:10-17,36-41`
- Modify: `packages/review/src/review-telemetry.ts:44,51,393-398`, `review-telemetry.test.ts`
- Modify: `packages/review-protocol/src/contracts.ts:9,1017-1031`, `src/index.ts:44-45,139-143`, `src/contracts.test.ts:166`
- Modify: `packages/review/src/server/desktop-server.test.ts:504-588`, `desktop-server-import.test.ts:251-287`, `review-busy.test.ts:104-130`

**Interfaces:**
- Produces: `desktop-server.ts` no longer exports or registers `/publish-ready`, `/repair-ready`, `/map-publish-ready`; `GlobalReviewServerInput` loses nothing else.

- [ ] **Step 1: Delete the three test surfaces first**

Delete `server/desktop-server-repair.test.ts` and `server/review-repair-promotion.test.ts`. In `desktop-server.test.ts` delete the top-level `it("rejects a publication whose review moved its base ref…")` at `:504-588`. In `desktop-server-import.test.ts` delete the `migrated`-refusal table at `:251-287`. In `review-busy.test.ts` delete the `runReviewPublish(...)` call (`:104-109`) and the `["publish-ready","map-publish-ready","repair-ready"]` fan-out (`:110-130`) and the corresponding `expect`s on those results; the test keeps asserting that `open` during a locked review reports busy.

Run `pnpm vitest run --config vitest.config.ts src/server/desktop-server.test.ts src/server/desktop-server-import.test.ts src/review-busy.test.ts`. Expected: the remaining cases pass (the deleted code is still present, so nothing else moves yet).

- [ ] **Step 2: Delete the routes and their helpers from `desktop-server.ts`**

Delete, by symbol: `PublishMountTiming` (`:139-143`), `MountVerbResultSchema` (`:145-157`), `mountStepTimings` (`:1265-1273`), the `promoteReviewRepair` import (`:132`), the `ReviewRepairReadyRequestSchema` import (`:105`), `importAfterPromotion` (`:325-332`), `migratedError` (`:334-341`), `POST /publish-ready` (`:1003-1043`), `POST /repair-ready` (`:1044-1070`), `POST /map-publish-ready` (`:1071-1106`), `mountPublishedDocument` (`:1274-1460`, now register-and-promote only), `mountPublishedSoftwareMap` (`:1461-1603`), `promoteReview` (`:2650-2674`), `promoteSoftwareMap` (`:2675-2688`), `rejectTerminalPublication` (`:2706-2718`), `rejectConcurrentPublication` (`:2719-2735`). Delete the `repairValidation` arm: the field at `:202`, the mode branch at `:2035-2038`, and collapse the ternary at `:2049-2053` to `findReview`. Delete the two `findReviewForRepair` call sites (`:1049`, `:2050`) and then `findReviewForRepair` from `review-home.ts:402`.

Keep `replaceLegacySessions` (`:309-323`): the importer's `onImported` uses it.

- [ ] **Step 3: Delete the repair modules and trim the session mode**

`git rm packages/review/src/server/review-repair-promotion.ts packages/review/src/review-repair-state.ts packages/review/src/review-repair-state.test.ts`. In `review-session-mode.ts` remove the `repairValidation` variant (`:11-17`) so `ReviewSessionMode` is `live | historical`; `reviewSessionModeIsReadOnly` keeps returning `!mode.isPromoted()`.

- [ ] **Step 4: Protocol and telemetry**

`contracts.ts`: delete `ReviewPublishReadyRequestSchema` + type (`:1017-1031`) and the `/publish-ready` mention in the header comment (`:9`). `index.ts`: delete the re-exports (`:44-45`) and `parseReviewPublishReadyRequest` (`:139-143`). `contracts.test.ts`: delete the `"publish-ready request"` case (`:166`).

`review-telemetry.ts`: delete `capturePublishGateRejected` (`:393-398`) and remove `"publish"` (`:44`) and `"map.publish"` (`:51`) from `ReviewCliCommandPath`. Delete its case from `review-telemetry.test.ts`. Keep `captureReviewReaped`.

- [ ] **Step 5: Typecheck, run the server suites**

```bash
pnpm --filter @dev.fast/review-protocol build && pnpm --filter @dev.fast/review-desktop protocol:sync
pnpm --filter @dev.fast/review typecheck
cd packages/review && pnpm vitest run --config vitest.config.ts src/server src/review-busy.test.ts src/review-telemetry.test.ts
```

Expected: pass. `desktop-server-import.test.ts` still proves sweep and open-time import.

- [ ] **Step 6: Commit**

```bash
git add -A packages/review packages/review-protocol apps/review-desktop
git commit -m "Delete the publish, repair and map-publish ready routes"
```

---

### Task 3: Delete the CLI writers

**Files:**
- Delete: `src/review-publish.ts`, `src/review-map-publish.ts`, `src/review-map-publish.test.ts`, `src/review-repair.ts`, `src/review-repair.test.ts`, `src/review-repair-preparation.ts`, `src/review-publication-preparation.ts`, `src/review-publication-staging.ts`, `src/review-publication-staging.test.ts`, `src/review-tree-fingerprint.ts`, `src/review-scaffold.ts`, `src/review-rebind.ts`, `src/review-internal-test.ts`, `src/review-scope-errors.test.ts`, `src/review-prepare.test.ts`
- Modify: `src/cli-runner.ts`, `src/cli.ts:71-77`, `src/map-cli.ts`, `src/publish-preparation.ts`, `src/publish-preparation.test.ts`, `src/review-worktree-target.ts`, `src/review-prepare.ts`, `src/review-artifact-promotion.ts`, `src/review-artifact-promotion.test.ts`, `src/review-home.ts:304`, `src/cli.test.ts`, `src/review-info.test.ts`, `src/review-head-checkout.test.ts`

**Interfaces:**
- Consumes: `syntheticLegacyReview` from `src/review-import/import-test-utils.ts:44` as the fixture builder that replaces `runReviewScaffold` in tests.

- [ ] **Step 1: Unregister the verbs in `cli-runner.ts`**

Delete the Commander registrations: `internal-test` (`:294-301`), `repair` (`:418-435`), `publish`/`present` (`:437-461`), `prepare-worktree` (`:463-482`), `scaffold` (`:504-550`), `rebind` (`:399-416`). Delete their imports (`:52,54,55,57,58`), runtime seam types (`:87-90,119`) and wiring (`:1036-1039,1068`). Trim telemetry classification: remove `"publish"` from the map subcommand union (`:1236-1240,1258-1272`), the `name === "publish" || name === "scaffold"` branch (`:1396-1406`), and `"publish" | "rebind"` from the error-category mapping (`:1444-1450`, keep `"info"`). In `cli.ts` remove `internal-test` and `prepare-worktree` from the delegation-exempt list (`:71-77`).

- [ ] **Step 2: Remove `review map publish` from `map-cli.ts`**

Delete the dispatch (`:128-137`), the option wiring (`:354-356`), the help lines (`:200`, `:211`) and the import (`:31`). Keep `resolvePublishReview` usage at `:618` and `:685` (`review map check --review`, `review map open`).

- [ ] **Step 3: Delete the writer modules**

```bash
cd packages/review
git rm src/review-publish.ts src/review-map-publish.ts src/review-map-publish.test.ts \
  src/review-repair.ts src/review-repair.test.ts src/review-repair-preparation.ts \
  src/review-publication-preparation.ts src/review-publication-staging.ts src/review-publication-staging.test.ts \
  src/review-tree-fingerprint.ts src/review-scaffold.ts src/review-rebind.ts src/review-internal-test.ts \
  src/review-scope-errors.test.ts src/review-prepare.test.ts
```

- [ ] **Step 4: Trim the shared modules**

`publish-preparation.ts`: keep only `resolvePublishReview` (`:98`) and its helpers; delete `prepareReviewPublish` (`:21`). Trim `publish-preparation.test.ts` to the `resolvePublishReview` cases.

`review-worktree-target.ts`: delete `prepareReviewSourceTargetForRef` (`:92`) and `ensurePinnedReviewWorktreeAtCommit` (`:122-176`). Keep `resolveReviewSessionBaseCommit`, `resolveReviewRepoRootFromStore`, `readReviewStoreRecord`.

`review-prepare.ts`: keep `removeReviewPrepareArtifacts` (`:66`) which `review-head-checkout.ts:20` imports; delete `prepareReviewPinnedCheckout` (`:78`), `markerMatches` (`:196`), `resolveReviewPrepareCliEntryPath` (`:215`), `spawnReviewPrepareBackground` (`:236`), `reviewPrepareCommandsHash` (`:55`) and now-unused imports. If the file is under 30 lines afterwards, move `removeReviewPrepareArtifacts` into `review-head-checkout.ts` and delete the file.

`review-artifact-promotion.ts`: delete `commitReviewArtifactPromotion` and `rollbackReviewArtifactPromotion`; keep `promoteReviewArtifactFiles` (used by `stored-review-migration.ts`). Trim its test to the kept function.

`review-home.ts`: delete `updateReviewPins` (`:304`); its only importer was `review-scaffold.ts`.

`review-head-checkout.test.ts`: delete the assertions that reference `review-prepare` markers.

- [ ] **Step 5: Reroute the tests that used scaffold as a fixture**

`cli.test.ts`: delete the cases at `:70` (repair routing), `:257` (registers scaffold and publish), `:569` (scaffold telemetry), `:667` (`--view` on publish), `:698` (scaffold `--json`), `:775`, `:828`, `:838` (removed `--with-map`), `:916` (prepare-worktree). Update the "registers …" assertion to the remaining verbs: `version, app, info, install, migrate, login, logout, whoami, trace, map, api, mcp`.

`review-info.test.ts`: replace every `runReviewScaffold({ cwd, … })` fixture with `syntheticLegacyReview(...)` from `src/review-import/import-test-utils.ts:44` (it creates a `~/.dev/reviews/<uuid>` directory with a pinned worktree without touching MDX). Delete the cases whose subject is scaffold behaviour itself (`:48`, `:257-320`, `:354` "re-pins with scaffold --update"); keep the `review info` resolution cases (`:139`, `:191`, `:228`, `:339`). `prepareReviewPublish` import (`:9`) goes.

Run:

```bash
pnpm vitest run --config vitest.config.ts src/cli.test.ts src/review-info.test.ts src/publish-preparation.test.ts src/review-artifact-promotion.test.ts src/review-head-checkout.test.ts src/map-cli.test.ts
```

Expected: pass. `map-cli.test.ts` cases that exercised `map publish` are deleted in the same run.

- [ ] **Step 6: Typecheck and lint; look for orphans**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm lint
cd packages/review && for f in review-source-pins review-derived-paths software-map-health; do echo "== $f"; git grep -l "from \"\./$f\"\|from \"\.\./$f\"" -- src | grep -v test; done
```

Expected: `review-source-pins.ts` still has `publish-stage.ts` and `stored-review-migration.ts`; `review-derived-paths.ts` still has `stored-review-migration.ts` and the fixture loader; `software-map-health.ts` `loadPublishSoftwareMaps` is still used by `scripts/build-tutorial-assets.ts` (PR 2 removes that). Anything with zero non-test importers is deleted now.

- [ ] **Step 7: Commit**

```bash
git add -A packages/review
git commit -m "Delete review publish, repair, scaffold, rebind and prepare-worktree"
```

---

### Task 4: Re-seed the live e2e harness without the writers

**Files:**
- Modify: `apps/review-desktop/scripts/native-authoring-e2e.mjs:440-680,750-770,884-960`
- Modify: `apps/review-desktop/scripts/legacy-import-live-home.sh` (comment only)
- Modify: `docs/superpowers/plans/2026-09-16-legacy-import-live-test-plan.md`

The harness seeds legacy reviews with `scaffold` + `publish` (`:440-445`, `:520-680`) and proves the `migrated` refusal (`:609-679`) and `repair` on an un-importable review (`:760`). Those flows no longer exist. The fixture tarballs in `packages/review/src/fixtures/legacy-reviews/*.tgz` are the seed instead, exactly as `legacy-import-live-home.sh:31-38` already does.

- [ ] **Step 1: Replace CLI seeding with fixture extraction**

Add a helper in the harness:

```js
async function seedLegacyFixture(homeDir, name) {
  const fixtures = path.join(workspace, "packages/review/src/fixtures/legacy-reviews");
  const { sourceUuid } = JSON.parse(await fs.readFile(path.join(fixtures, `${name}.json`), "utf8"));
  const dir = path.join(homeDir, "reviews", sourceUuid);
  await fs.mkdir(dir, { recursive: true });
  await run("tar", ["-xzf", path.join(fixtures, `${name}.tgz`), "-C", dir]);
  return { uuid: sourceUuid, dir };
}
```

Use it where `scaffold`/`publish` produced `uuid`/`dir`. Delete the E1 "positioned publish errors import nothing" block (`:520-568`), the E4 `migrated` block (`:609-679`), and the `repair` call at `:760`; keep E2/E3 (first Home refresh imports and renders in the JSON canvas) and the golden comparison at `:784-810`. Delete the `--baseline-runtime` benchmark seeding that scaffolds and publishes the tutorial (`:884-960`) or repoint it at the same fixture seeding.

- [ ] **Step 2: Run the harness against a staged runtime**

Follow `docs/superpowers/plans/2026-09-16-legacy-import-live-test-plan.md` to stage the runtime and start the Desktop on a scratch home, then run `node apps/review-desktop/scripts/native-authoring-e2e.mjs`. Expected: exit 0, `report.checks` includes "first publish imports and renders in the JSON canvas" renamed to "fixture review imports and renders in the JSON canvas".

- [ ] **Step 3: Update the live-test plan and the home script comment**

Remove the `review publish`/`repair` steps from the live test plan; note that seeding is by fixture. In `legacy-import-live-home.sh` drop the sentence about `review repair` still working on the system review (`:119`).

- [ ] **Step 4: Commit**

```bash
git add apps/review-desktop/scripts docs/superpowers/plans/2026-09-16-legacy-import-live-test-plan.md
git commit -m "Seed the import e2e harness from legacy fixtures"
```

---

### Task 5: Docs and skill

**Files:**
- Modify: `packages/review/skills/dev-review/SKILL.md:43`
- Modify: `docs/cli-reference.md:36-37,49,73-78,99,105-110,124,128,138`
- Modify: `docs/how-review-works.md:39,43,48,50,63,85,98,103,134`
- Modify: `docs/troubleshooting.md:55,68,81,95,104,115`
- Modify: `docs/telemetry.md:183,259`
- Modify: `packages/review/README.md:3,46,55,58,67,79,85,88`
- Modify: `packages/review/onboarding.md` (whole file; shipped in the npm `files` list)
- Modify: `apps/review-desktop/README.md:12-13,75,81,94,173`
- Modify: `scripts/review-latency/README.md:38,51,52`

- [ ] **Step 1: Rewrite the authoring story once**

`onboarding.md` becomes a five-line pointer: install, open Desktop, run the dev-review skill, which authors through `review api` / MCP. `packages/review/README.md:3` becomes "dev.fast Review is a JSON review canvas hosted by Review Desktop." and the scaffold/publish sections (`:46-88`) are replaced by a link to `skills/dev-review/SKILL.md`. `SKILL.md:43` is replaced by: "Legacy `review scaffold/publish/repair` commands no longer exist. Reviews published from MDX before this release were imported into the JSON store and are edited through `review api` or these MCP tools."

- [ ] **Step 2: Remove the verbs from the reference docs**

`docs/cli-reference.md`: delete the `scaffold`, `publish`, `repair` rows and sections; keep `map` with `open|check|prune|push|fetch`; add rows for `api` and `mcp` pointing at `review api tools`. `docs/how-review-works.md`: replace the "Authoring remains review.mdx and data.ts" paragraphs (`:48`, `:134`) with the JSON route; delete `:43,63,98,103`. `docs/troubleshooting.md`: delete the six publish/scaffold entries. `docs/telemetry.md`: delete the `review_publish_gate_rejected` row (`:183`) and the note at `:259`. `apps/review-desktop/README.md`: delete `:12-13` (publish-ready), `:75`, `:81`; keep `:90-94` but reword to "were imported". `scripts/review-latency/README.md`: mark the publish-keyed phases as historical.

- [ ] **Step 3: Grep for leftovers**

```bash
git grep -n "review publish\|review scaffold\|review repair\|review rebind\|publish-ready\|map publish\|prepare-worktree" -- docs packages/review/README.md packages/review/onboarding.md packages/review/skills apps/review-desktop/README.md
```

Expected: no hits except the historical note in the latency README.

- [ ] **Step 4: Commit**

```bash
git add docs packages/review/README.md packages/review/onboarding.md packages/review/skills apps/review-desktop/README.md scripts/review-latency/README.md
git commit -m "Document the JSON API as the only authoring route"
```

---

### Task 6: Full verification and PR

- [ ] **Step 1: Full lanes**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm --filter @dev.fast/review-desktop typecheck
pnpm lint && pnpm format:check
cd packages/review && pnpm test:node && pnpm test:browser
```

Compare failures against the baseline list in memory; anything new is yours.

- [ ] **Step 2: Size check**

```bash
git diff --stat origin/feat/legacy-review-import | tail -1
```

Expected: roughly 6,000–8,000 lines removed, under 300 added.

- [ ] **Step 3: Open the PR**

Open the PR against `feat/block-validators` (or `main` once that branch and #296 have merged). Title: "Stop writing legacy reviews". Body: the goal paragraph above, the list of deleted verbs, the kept modules and why (tutorial, historical sessions, importer), and the e2e evidence from Task 4. No attribution footer.

## Self-review

- Spec coverage: §1a (mount) Task 1; §2a (three ladders) Tasks 2–3 delete rather than fold; §2e (worktree resolution) Task 3 Step 4; §2g deferred to PR 3 (migration stays for the read path). Docs from the audit's §7 telemetry note handled in Task 5.
- Not covered on purpose: `review info`, `review app pick`, `review migrate` (PR 5); `loadPublishSoftwareMaps` and `bundleReviewSoftwareMap` (PR 2/3).
