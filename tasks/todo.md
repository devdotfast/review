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
