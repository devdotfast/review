# Batch authoring: implementation handoff

This plan records a side conversation with the user on 2026-09-18. The user requested this file for the main agent. Only this handoff document was created in the side conversation; implementation remains with the main agent.

## Goal

Provide an explicitly selected batch authoring workflow for headless/CI use. The model works on a draft and commits one finished review version, without creating a version for every edit or maintaining UI progress messages. Retain the existing review document format, components, source validation, and resource support.

CI continues to supply the agent harness, model credentials, prepared checkout, and explicit base/head revisions. Review supplies authoring tools and skill instructions.

## Agreed behavior

1. **Persistent working draft, one committed version.** Incremental draft writes are saved as working state without appending review history. The model may write large portions at once and make targeted corrections before committing.
2. **Explicit mode selection.** Batch authoring is chosen deliberately. Do not infer it solely from Desktop being unavailable. Desktop availability and authoring workflow are separate capabilities.
3. **Creation and updates.** A new review can be authored this way. For an existing review, readers continue to see its last committed version while the draft is being authored. Commit creates the next version.
4. **Discard abandoned work by default.** The user explicitly preferred simplicity over recovery features. There is no resume/rebase/merge workflow in this scope. A new run starts from the last committed review, or an empty document for a new review, after the previous owner has stopped or explicitly aborted. Do not discard an active owner's draft or steal its lock.
5. **Commit validates and completes.** Validate the document and its references, then automatically set every section's status to `complete`, including nested sections. The model does not need to generate pending/in-progress/complete transitions. The skill is responsible for checking the substance before committing; status normalization is not proof of content quality.
6. **Separate batch skill.** The model reads a short dedicated skill when batch mode is selected. Share the existing document/component reference rather than duplicating it. Keep interactive authoring instructions separate.
7. **Server-owned exclusive authoring session.** The headless server owns the review's lock for the draft's lifetime. Release on successful commit, explicit abort, or server shutdown. The model does not renew leases or send activity/focus messages. If the agent dies but the server remains running, the draft remains locked until abort or server shutdown. CI is responsible for stopping its server during teardown.

The temporary draft is persisted for the active run, but it is not a recoverable historical version. After an unclean server exit, abandoned scratch state is discarded as part of safe orphan cleanup, rather than offered for resumption.

## Suggested interface

The workflow above is agreed. Exact names and argument shapes below are implementation suggestions, not existing commands or separately approved API requirements.

Expose an explicit startup option such as `review server start --authoring-mode batch`. Report `authoringMode` through capabilities. Tool descriptions and the skill must agree about whether writes target a draft or a committed review.

The model-facing path should be:

```text
begin draft (new review or existing review ID)
    → inspect source, upload resources, write draft
    → validate / correct
    → commit → committed review ID and version
```

Provide abort for failures. A possible tool family is `review_draft_begin`, `review_draft_write`, `review_draft_validate`, `review_draft_commit`, and `review_draft_abort`. Prefer a bulk document write as the normal path. Reuse existing edit operations for targeted corrections if that is straightforward; avoid creating a second document language.

Draft reads and source/resource tools must work before the first committed version exists. Return the draft identity and the IDs needed for subsequent edits. Source pins and repository identity belong to the draft, so a new review does not need an empty committed placeholder just to use source tools.

## Implementation outline

### 1. Separate draft working state from committed history

Inspect the current store and use the smallest representation that supports one mutable draft per review. Store the draft's document, title, pins, relevant origin metadata, owner identity, and the committed version it started from. Preserve the existing ID-allocation rules; do not create component-ID collisions or recycle IDs during an update.

Draft writes update working state only. The ordinary catalog, review reads, and history continue to expose committed state. Keep the distinction explicit in internal APIs so existing `review_edit` calls cannot accidentally create intermediate versions during batch authoring.

### 2. Enforce ownership across mutation paths

Acquire exclusive ownership when beginning a draft, before reading the starting version. Enforce ownership in the storage/mutation boundary, including interactive edits, renames, repins, restores, deletes, and imports that could change that review. Reads remain available. Different reviews remain independently authorable.

The main thread has session-lock work in progress around `review_activity`, lease IDs, and heartbeat expiry. Reconcile with that work: batch authoring must use server-owned lifetime management, not require the model to call the interactive heartbeat API. Inspect current files before changing them; do not blindly undo ongoing work.

Use a short database transaction or a robust cross-process ownership mechanism for acquisition/release. Do not hold a SQLite write transaction open while the model works or while awaiting source validation. Detect a dead server safely; elapsed time alone must not steal a live server's draft. Keep ownership checks at commit so a former owner cannot write after losing ownership.

### 3. Make commit atomic and retryable

Validate using the existing shape, component-reference, source, pin, and resource validators. Normalize every section to `complete`. Then atomically append one snapshot, advance the current-version pointer, and clear the draft/ownership state. A new review becomes a committed review at this point, with no earlier empty version.

Recheck ownership and the expected starting version at the transaction boundary. On validation failure, leave the draft available for correction and leave committed state untouched. On a lost successful response, retrying the same commit command must return the same result rather than append another version; reuse the existing command-receipt pattern.

After success, use the normal committed-review notification path. Automatic commit on timeout, shutdown, or disconnect is out of scope.

### 4. Add mode-aware tools and the batch skill

Expose the mode through capabilities and publish truthful tool descriptions. The batch skill should instruct the model to begin a draft, investigate the pinned source, author substantial chunks, inspect/validate, and commit. It should return the committed review ID/version and abort on an intentional failure path.

The entry skill can route to the batch skill when the selected mode requires it. Reuse shared component documentation. Remove interactive outline-status choreography and activity/focus updates from the batch path. Do not remove investigation, evidence checking, or document-quality checks.

Add a short local example and a CI example showing explicit mode selection, agent invocation, and server teardown. Update documentation that currently says every accepted edit becomes a saved version to distinguish interactive edits from draft writes.

## Acceptance checks

- Multiple draft writes produce no additional committed history. A successful commit produces exactly one version.
- New-review authoring works before a committed review exists; abort leaves no empty review in the ordinary catalog.
- During an update, normal readers see the previous committed document until commit succeeds.
- Invalid content cannot change committed state; correcting the same draft allows commit.
- All sections, including nested sections with omitted or unfinished statuses, are complete after commit.
- Another process cannot begin or mutate the owned review. Work on another review remains possible.
- Abort and graceful server shutdown release ownership. After a killed server, a later owner can safely discard the orphaned draft. A live server is not evicted merely because its agent stopped making calls.
- Commit retries are idempotent, and commit cannot overwrite a different starting version or proceed under stale ownership.
- CLI and MCP expose the selected workflow consistently. The batch workflow needs no model-issued heartbeat or focus calls.
- Interactive authoring behavior remains intact outside the agreed ownership restrictions.

Use meaningful behavioral/integration tests, especially across processes. Follow the repository instruction against Change Detector Tests.

## Scope boundaries

This work does not include draft resumption, merging/rebasing drafts, collaborative editing, portable export, upload/sharing, model execution, credential management, or checkout provisioning. Resource reclamation should follow existing policy; a new garbage-collection subsystem is not required for this feature.

Whether Desktop and headless hosts share a default database/directory remains a separate architectural decision. Batch ownership addresses authoring conflicts, but does not by itself solve cross-process notifications or managed-workspace ownership. Do not silently bundle a shared-directory migration into this implementation.

## Starting points in the current checkout

- `packages/review/src/review-api/store.ts`: command execution, snapshots, transactions, receipts, imports.
- `packages/review/src/review-api/activity.ts`: session/activity work being changed in the main thread.
- `packages/review/src/review-api/local-data.ts`: source and resource validation.
- `packages/review/src/review-api/http.ts`, `authoring-tools.ts`, and `agent-client.ts`: API and agent tool surface.
- `packages/review/src/server/headless-host.ts` and `packages/review/src/cli-runner.ts`: server lifetime and mode selection.
- `packages/review/skills/dev-review/`: current entry skill and shared authoring references.
- `docs/headless-authoring.md` and `docs/adr/`: existing scope and architecture documentation to reconcile with the new workflow.

Implementation is not performed by this handoff. The main agent should check its current in-progress changes against this plan before proceeding.
