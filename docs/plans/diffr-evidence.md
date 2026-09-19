# Direct diffr evidence in Review

## Agreed behavior

An AI model retrieves hits, calls the diffr JS API (hydrate, candidate/side selection, postprocess, optional Jev), inspects pretty output, then submits the structured selected results through Review's existing MCP/HTTP/code-mode authoring operations. Review validates, persists, and renders the supplied evidence. It does not rerun the search or require a separate resource upload.

Source locations remain `{side,file,fromLine,toLine}`. Displayable code evidence becomes `Source | SearchResultData`. A Source displays its explicit side/ranges; a diffr result displays exactly its supplied source pairing. Head-only evidence must remain head-only even for modified files. Focus/navigation coordinates do not add a display side.

Diffr's wire fields retain their existing names. Review consumes shared method-free transport types and a runtime schema; its separate structural declarations must not drift from diffr. Search highlights and fold visibility are rendered from the supplied trees, without another context-expansion or opposite-side inference pass.

## Contracts to scaffold, then implement

```diff
+export type CodeEvidence = Source | SearchResultData;
+export const codeEvidenceSchema = z.union([sourceSchema, searchResultDataSchema]);

 // Code peek, sequence step, frame, and code-backed operation fields:
-source: sourceSchema
+source: codeEvidenceSchema

 // File lens targets:
+{kind: "results", results: SearchResultData[]}

 // Native inline editor content:
-path: string;
-side: ReviewDiffSide;
-ranges: readonly ReviewInlineEditorRange[];
+content:
+  | {kind: "source"; path: string; side: ReviewDiffSide; ranges: readonly ReviewInlineEditorRange[]}
+  | {kind: "diffr"; result: SearchResultData};
```

Existing multiple-range, selection, count, event, and presentation behavior must be accounted for in implementation. Use existing Source locations for navigation within evidence, not a new focus/storage abstraction.

## Stored state

Review persists submitted results inline in its existing versioned document JSON (`versions.snapshot`). Existing Source blocks remain valid. No SQL migration, new table, resource-upload requirement, or retained-result wrapper. Save only authored evidence, not every candidate. Inline duplication is acceptable initially.

Diffr's StoredDiff and Store backend schemas are unchanged: they cache query-independent computed trees, never selected highlights or processed visibility. A Review must reopen with its authored evidence even if that cache is cleared.

Validate receiving repository/commit compatibility, file identities and source text, source pairing, and region/span bounds. Treat submitted worktree paths as metadata, never as permission or instructions to open paths. On repin/worktree refresh, incompatible results must be stale or require replacement; never reinterpret their trees against new pins. Sharing/version restore must carry the evidence intact.

## Implementation and verification

1. Commit this plan in both repos. Amend each plan commit with API and stored-JSON contract scaffolding; incomplete builds are permitted for this layer.
2. Create a separate implementation change on top in each repo. Do not amend behavior into the contract layer.
3. Implement shared diffr serialization/schema, Review validation/persistence/transport, and native rendering with exact side preservation and highlight/fold support.
4. Test meaningful behavior: round trips, invalid/pin-mismatched evidence, existing Source input, left/right/paired/unchanged results, nested highlights/folds, reopen with diffr cache unavailable, repin handling, and lenses/other evidence-bearing blocks.
5. Build a Review dev app. Query a subset of the implementation's own pinned diff via real diffr JS calls. Submit the selected structured evidence through the real Review authoring API, reopen the document, and inspect it in the app. Include a head-only result from a modified file and verify no base-side rows are manufactured.

## Change control

The user requires a stop and explicit flag before any API/data-flow deviation or additional storage schema is introduced. The contract changes listed here are the agreed baseline. Do not silently add an upload/resource model, a server-side search flow, storage tables, or new result wrappers. Record any necessary deviation and obtain the user's direction before dependent implementation.

Implemented with Codex assistance.

## Approved transport additions

The native ReviewDiffLens carries a per-target ADT: `{kind: "ranges", ranges: Source[]}` or `{kind: "results", results: SearchResultData[]}`, replacing its flat ranges property. ReviewInlineFindSpec uses the same content union as ReviewInlineEditorSpec so pre-mount find searches precisely the evidence that will render. Approved after the initial scaffold; no additional stored state.
