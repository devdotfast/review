# Lifecycle and storage

## One owner

Desktop runs one local HTTP Review Host. UI, CLI and MCP use the same commands, queries and events. The host owns saved review versions, evidence, maps, comments, private drafts and completed answers. Its database and filesystem layout are implementation details, not a client API.

Do not edit SQL, review files, Git notes or bundles. No migration of old MDX reviews is provided; old data is left untouched. The trusted bundled tutorial is an explicit legacy exception.

## Code versions

Creation resolves a change selector to exact commits. Supported selectors are:

- `{kind:"range",baseRef,headRef}`
- `{kind:"branch",name,baseRef}`
- `{kind:"jj_change",changeId,baseRef}`
- `{kind:"pull_request",url}`
- `{kind:"snapshot",ref}` for an architecture review

Use the returned binding, not your current checkout, as the source authority.

`review.revision.create({reviewId,expectedReviewVersion,change})` selects new code and creates a blank canvas with no selected maps. Review details, old versions and discussions remain. The same resolved commits are rejected instead of clearing content. Reauthor deliberately from the new diff, using fresh IDs when carrying content over.

The conservative comment remapper follows surviving contiguous lines and detected renames. Ambiguous or missing locations remain attached to the original conversation; it does not rewrite prose or diagram meaning.

## Saved versions and retries

One `reviewVersion` identifies canvas, title, description, labels, source binding and selected maps. Every changed material write saves a new immutable version, starting at 0. Use `expectedReviewVersion` for edits. Comments and lifecycle actions do not change this number.

Commands use caller-chosen UUID receipt IDs. Retry an uncertain result with the same ID and input. A changed request needs a new ID. Refetch and reconcile real conflicts.

`review.history` lists saved versions. Historical views are read-only. `review.version.restore({reviewId,expectedReviewVersion,fromReviewVersion})` copies the complete old snapshot into a new version, even if identical. It never erases later history or conversations, changes lifecycle state, or carries approval forward.

Maps are independent immutable resources. Select exact map IDs using `review.update` with a `mapVersions` patch: omitted sides stay unchanged; null clears a side. Inline `software_map` nodes independently name exact map versions.

Open/closed/trash state has a separate `stateVersion`. Close/reopen/trash/untrash use `expectedStateVersion`. A closed or trashed review remains readable but rejects new edits and discussions. An already accepted Ask answer can still complete. Live views receive whole committed versions; historical material stays fixed. There is no publish/checkpoint step or render-report API.

## Conversations

`thread.get` returns immutable posted messages; append with `thread.reply`. The server assigns message IDs. `thread.set_status` uses `expectedThreadVersion`. Preserve original targets; query `thread.mapping` to see their location in a selected review version. A missing mapping does not erase the saved conversation.

Human drafts are private, explicitly saved and nonblank. `feedback.submit` atomically posts selected `{draftId,expectedDraftVersion}` entries and a decision for an observed `reviewVersion`. Decisions do not close the review. It does not need an agent online; authors query feedback and respond through the API later.

Ask saves a question and frozen context before launch. A fresh local harness receives read/answer-scoped API access, not author permission. Completed answers are durable; failed launches and interrupted runs remain visible and can be explicitly retried. Do not promise automatic process recovery, partial-answer streaming, cancellation or transcript forking.
