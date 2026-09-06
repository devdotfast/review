# Task E6 report

Status: DONE

Implemented E6 by replacing all six deferred promise helpers in the progressive-review tests with `Promise.withResolvers`, including the A7 map-sealing regression helper added by the E6 reconciliation ruling. Raised the progressive-review TypeScript lib target from ES2022 to ES2024 so the API typechecks. Existing staging and map-publish concurrency synchronization, failure-safe release cleanup, and assertions are unchanged.

## Validation

- Baseline: `cd packages/progressive-review && pnpm exec vitest run --config vitest.config.ts src/review-mutation-lock.test.ts src/review-busy.test.ts src/review-publication-staging.test.ts src/stored-review-source-migration.test.ts src/stored-review-migration.test.ts` — 5 files passed, 53 tests passed; duration 24.52s.
- Focused post-change tests: same command — 5 files passed, 53 tests passed; duration 24.59s.
- Map regression baseline: `cd packages/progressive-review && pnpm exec vitest run --config vitest.config.ts src/review-map-publish.test.ts` — 1 file passed, 1 test passed; duration 734ms.
- Map regression post-change: same command — passed (1 file, 1 test).
- `pnpm exec oxfmt --write packages/progressive-review/src/review-mutation-lock.test.ts packages/progressive-review/src/review-busy.test.ts packages/progressive-review/src/review-publication-staging.test.ts packages/progressive-review/src/stored-review-source-migration.test.ts packages/progressive-review/src/stored-review-migration.test.ts packages/progressive-review/src/review-map-publish.test.ts` — finished on 6 files.
- `pnpm exec oxlint --disable-nested-config packages/progressive-review/src/review-mutation-lock.test.ts packages/progressive-review/src/review-busy.test.ts packages/progressive-review/src/review-publication-staging.test.ts packages/progressive-review/src/stored-review-source-migration.test.ts packages/progressive-review/src/stored-review-migration.test.ts packages/progressive-review/src/review-map-publish.test.ts` — 0 warnings, 0 errors. Existing Node `MODULE_TYPELESS_PACKAGE_JSON` warning emitted by the anti-slop plugin loader.
- `pnpm --filter @dev.fast/review typecheck` — passed; workspace dependencies rebuilt and progressive-review `tsc --noEmit` completed successfully.
- `git diff --check` — passed.
- `grep -rn "function deferred" packages/progressive-review/src` — no output.

## Files changed

- `packages/progressive-review/tsconfig.json`
- `packages/progressive-review/src/review-mutation-lock.test.ts`
- `packages/progressive-review/src/review-busy.test.ts`
- `packages/progressive-review/src/review-publication-staging.test.ts`
- `packages/progressive-review/src/stored-review-source-migration.test.ts`
- `packages/progressive-review/src/stored-review-migration.test.ts`
- `packages/progressive-review/src/review-map-publish.test.ts`

There are no `function deferred` helpers remaining under `packages/progressive-review/src`.

## Self-review

The diff is limited to the requested TypeScript lib declaration and helper/call-site replacements. No casts, suppressions, mocks, or behavior changes were added. The independent `entered`/`release` promise pairs and cleanup assertions remain intact.
