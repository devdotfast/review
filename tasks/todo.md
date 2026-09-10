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
Base: PR #187 at 19d12b1d3dcb1c742f461b5f7650c73b70ffb255, stacked on #161.

- [ ] Share authoring aliases/helpers and diagnostic conversion.
- [ ] Use generated declarations in installed checking and current sources in development.
- [ ] Restore helper semantic checking for internal-test without broadening publish checks.
- [ ] Distinguish runtime bindings from type-only imports and use one TypeScript transform.
- [ ] Support local JavaScript-to-TypeScript extension substitution.
- [ ] Exclude parent callbacks from the worker execution deadline.
- [ ] Fix intrinsic tags, declared-model ordering, headings, expression spans, and parser errors.
- [ ] Retain hydrated documents and successful peeks across partial failures.
- [ ] Consolidate staged-runtime inspection; retain final full-application/ASAR checks.
- [ ] Replace broad frozen-output equality with focused compatibility contracts.
- [ ] Remove redundant guards/scaffold branch; retain the used routePath.
- [ ] Run focused regressions, workspace CI, installed-runtime E2E, and cold/warm benchmarks.
- [ ] Review final diff and coordinate the updated #187 with dependent #188/#190.

No changes to #228. No handwritten declarations, compiler/module caches, generic
diagnostic framework, or golden-regeneration system.
