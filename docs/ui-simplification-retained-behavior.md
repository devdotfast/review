# Deliberately retained UI behavior

The post-comments UI cleanup leaves these candidates in place:

- Document rendering uses `createElement` because tag and component identity come from document data. The remaining cosmetic call sites in `agent-markdown.tsx` and `review-view-state.ts` can change when those files next need editing.
- The Diff tab opens an editor; the Files and commit-scoped Files views already share one implementation.
- Per-editor bridge handles own height, error, find, and disposal behavior. A canvas-wide mount API would need to preserve these lifetimes.
- Separate review state and action contexts isolate open peeks from unrelated updates.
- The React height estimator sizes placeholders before a workbench editor exists; the workbench estimator operates during the editor lifecycle. Sharing them is outside this cleanup's scope. The protocol generator can carry functions, as the shared exact-range diff counter demonstrates. Keep their minimum-one-line clamp aligned if either estimator changes.
- Scroll restoration observes all descendants with `ResizeObserver`; narrowing its coverage needs a reproduced problem.
- Read-only peek editors retain `domReadOnly: false` pending an accessibility check.
- Reloaded diff content duplication was reported before this cleanup. The suspected unified-diff remainder/line-mapping and cached-patch interaction needs separate instrumentation; this cleanup does not diagnose or fix it.
- The README hero and four redesign PNGs remain out of scope. The hero still needs a separate capture reflecting the removed Ask/Threads UI.

Runtime code-peek resolution and its success/failure telemetry are removed. Source validation remains part of publication. Native editors still report unavailable sources locally, and native headers retain exact authored-range counts, including original grouped selections before display-range merging.

## E: canonical source ranges

- `AnchorRef.peek` is the canonical `Source` (`{ side, file, fromLine, toLine }`)
  from `packages/review/src/source.ts`. The authoring *input* (`peek: { file,
  fromLine, toLine, graph?, theme? }`) is unchanged; `graph` maps to `side`
  (default `head`) and `theme` is accepted but no longer carried.
- Sealed bundles written before this change store
  `{ __kind: "code-peek-ref", props, resolution: null }`. The server upgrades
  them when it reads the bundle (`readReviewDocumentBundle`); files on disk
  are not rewritten.
- `ReviewDefinitionEnvironment.resolveCodePeek` became `validateCodePeek`,
  returning `void`; `CodePeekResolutionContext` is `CodePeekValidationContext`.
- Path, bounds and blank-range checks are shared by legacy publish and JSON
  accept (`source.ts`). Legacy still reads the pinned worktree; JSON reads the
  blob at the pinned commit. The blank-range rule applies to code peeks only.
- The peek side panel content is `{ kind: "source", source }`; `CodePeekCard`
  and `CodePeekGroup` take `Source` values. JSON `code_peek` blocks render
  directly, with no source-text fetch during document load.
- JSON commands still commit without the off-screen test-render gate.
