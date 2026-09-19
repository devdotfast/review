# Direct diffr evidence: verification checkpoint

The contract scaffold is `bb635df4`. Implementation commits begin with `2a7b8dfb` (server validation/persistence) and `6da6620f` (UI/native consumers). Diffr's scaffold is `a4f76a4ad`; its shared-schema implementation is `71d8db355`.

## Verified

- Review backend: 56 local-data tests and 50 additional API/source tests passed. Saved structured evidence reopens without submitted worktree paths. Invalid pins, text and blob identity are rejected. Repinning marks retained evidence stale.
- Review and native TypeScript checks pass; diffr TypeScript passes.
- Diffr's existing pretty-output tests are unchanged. A new real hydrate/postprocess round-trip test validates the shared schema.
- Native tests cover UTF-8 highlight conversion, one-sided rows, nested fold expansion, paired changed lines, and pinned API reads. Two existing API test inputs were migrated to the approved content ADT; their assertions remain.
- Dev build launched using isolated `/tmp/review-evidence-dev` state.
- `diffr-search/tests/code-mode/review.live.ts` queried `Diffr evidence text differs` in this implementation's `local-data.ts`, compared `bb635df4` to `6da6620f`, hydrated/postprocessed paired and deliberately head-only results, and submitted them through the real Review HTTP authoring API.
- Query worktrees were removed before opening the saved Review. The app displayed the head-only excerpt with a search highlight. UI checks confirmed local nested fold toggling, finding a visible token, a head-only lens (+50/-0), and a paired lens (+50/-5) with deleted and added lines.

The dev Review is `155228a7-5de2-42c9-91a1-8985e929d0f2`, version 5. Local evidence artifacts are in `/tmp/review-evidence-e2e/` (`evidence.json`, `pretty.txt`, `review.json`). No server credentials are included in these artifacts.

## Awaiting contract direction

The progress API currently supplies only flattened sources for diagram lenses, and native diagram sections also contain only sources. This loses target provenance when combining file globs with structured results and cannot preserve each section's ownership of a result reliably. Proposed extension: carry the existing `ReviewDiffLensTarget[]` ADT through `DiagramLens.targets` and `ReviewDiffSection.targets`, retaining `sources` solely for coverage/navigation. No stored-state change is needed. Do not implement this extension until approved.

Full mixed-lens/section verification and final stacked PR submission remain pending. The dev app also reports a language-environment setup issue; source navigation has not yet been verified end-to-end.
