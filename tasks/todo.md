# Simplification pass

- [x] A. Remove dead files, exports, routes, styles, and dependencies.
- [ ] B. Consolidate duplicate helpers and implementations. The shared app and backend helpers are complete. The wider Code OSS refactors remain.
- [x] C. Improve measured hot paths without behavior changes.
- [x] D. Simplify build, test, and packaging tools.
- [x] E. Move the checker and emitter toolchain to TypeScript 7.
- [ ] F. Replace or remove source-text contract tests case by case. Keep this test-strategy change separate from the dead-code pass.
- [x] G. Move live trace contracts into `review-protocol` and remove `trace-shared`.
- [x] Run the plan's automated checks.
- [ ] Run the plan's manual desktop checks. The app launch and Review render passed. Custom-surface automation blocked the remaining interactions.
- [x] Review the final diff against `origin/main`.

Deferred items remain out of scope. See the source plan for the complete list.

# PR #187 native authoring fixes and cleanup

Approved implementation plan: preserve public authoring syntax, document schemas,
fresh-worker isolation, mount-before-promotion, and sealed legacy migration.
Reviewed at PR #187 commit 19d12b1d3dcb1c742f461b5f7650c73b70ffb255.
Implementation rebased onto refreshed #187 head dd3fc8b91 after #161 merged.

- [x] Share authoring aliases/helpers and diagnostic conversion.
- [x] Use generated declarations in installed checking and current sources in development.
- [x] Restore helper semantic checking for internal-test without broadening publish checks.
- [x] Distinguish runtime bindings from type-only imports and use one TypeScript transform.
- [x] Support local JavaScript-to-TypeScript extension substitution.
- [x] Exclude parent callbacks from the worker execution deadline.
- [x] Fix intrinsic tags, declared-model ordering, headings, expression spans, and parser errors.
- [x] Retain hydrated documents and successful peeks across partial failures.
- [x] Consolidate staged-runtime inspection; retain final full-application/ASAR checks.
- [x] Replace broad frozen-output equality with focused compatibility contracts.
- [x] Remove redundant guards/scaffold branch; retain the used routePath.
- [x] Run focused regressions, workspace CI, installed-runtime E2E, and cold/warm benchmarks.
- [x] Review final diff and coordinate the updated #187 with dependent #188/#190.

No changes to #228. No handwritten declarations, compiler/module caches, generic
diagnostic framework, or golden-regeneration system.

Validation completed:

- Workspace: 2,040 tests passed, 2 skipped; typecheck, lint, formatting, Desktop
  CI_FAST build, and tutorial validation passed.
- Installed declaration-path correction: 25 focused tests and package typecheck
  passed. Production runtime staging and relocatability/bundler checks passed.
- Production-installed CLI with the rebuilt development Desktop: 11 E2E checks
  passed, including rendering, rollback, repair, and three historical migrations.
- Dependent stack: package typecheck and 115 focused tests passed after replaying
  #188/#190, retaining bounded cache retries and the stronger legacy preflight.
- Old-pipeline performance gate: all 20 installed builder/CLI cases passed, with
  30 warm and 20 cold samples per runtime/case. Median ratios were 0.641–0.758
  for builders and 0.784–0.936 for CLI publication; p95 ratios were 0.585–0.753
  and 0.785–0.930 respectively (limits: median 1.05, p95 1.10). Baseline source:
  5e8ba2be; runtime under test: 7b6250569, on Node 24.20.0, Darwin arm64.
