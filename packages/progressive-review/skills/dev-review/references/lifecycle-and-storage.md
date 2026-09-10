# Lifecycle and storage

## One owner

Desktop runs one local HTTP Review Host. UI, CLI and MCP use the same commands, queries and events. The shared `$DEV_REVIEW_HOME/review-host.db` (default `~/.dev/review-host.db`) owns reviews, immutable document versions/evidence/maps, checkpoints, comments, private drafts and completed answers. Its schema and filesystem layout are implementation details, not a client API.

Do not edit SQL, review files, Git notes or bundles. No migration of old MDX reviews is provided; old data is left untouched. The trusted bundled tutorial is an explicit legacy exception.

## Pins and repinning

Creation resolves a change selector to exact commits. Supported selectors are:

- `{kind:"range",baseRef,headRef}`
- `{kind:"branch",name,baseRef}`
- `{kind:"jj_change",changeId,baseRef}`
- `{kind:"pull_request",url}`
- `{kind:"snapshot",ref}` for an architecture review

Use the returned binding, not your current checkout, as the source authority. Publishing never moves pins.

To move pins, call `review.repin.plan({reviewId,expectedDocumentVersion,change})`. Inspect each anchor's `exact`, `relocated` or `missing` result and diagnostics. The existing conservative diff remapper tracks surviving contiguous ranges and detected renames; it does not infer replacement code for changed ranges.

Apply with `review.repin.apply({reviewId,planId,expectedDocumentVersion,operations})`. Include explicit anchor corrections and remove/replace stale map references in the same atomic operation. Diagrams are author-maintained; line tracking does not rewrite their meaning. Failure preserves the last accepted binding/document. Original evidence and checkpoints remain immutable.

## Versions, retries and publication

Document and review metadata versions are independent. Use the relevant expected version for each write. A comment, viewed marker or another review's edit does not invalidate the document version.

Commands use caller-chosen UUID receipt IDs. Retry an uncertain result with the same ID and input. A changed request needs a new ID. Refetch and reconcile real conflicts.

`review.publish` checks the expected document and metadata versions and freezes an immutable checkpoint with exact selected map-version IDs (or `null`). Maps can be authored independently; publish another checkpoint when the selection changes. There is no separate Git-note or map-bundle publication.

| Workflow | Meaning |
| --- | --- |
| `draft` | Not yet published |
| `in_review` | Published for a reviewer |
| `changes_requested` | Submitted feedback requests author changes |
| `closed` | Closed by a human decision/action; explicit reopen is required |

Live views receive atomic committed events. Historical checkpoint views ignore working-document updates. Render reports are observations of a version, not the server's commit gate.

## Conversations

`thread.get` returns immutable posted messages; append with `thread.reply`. Use message IDs and command receipts for deduplication. `thread.status` uses the thread's expected version. Preserve original targets; query `thread.mapping` to see their location in a later document. A missing mapping does not erase the saved conversation.

Human drafts use `draft.save/delete` and `drafts.list` and are private until submitted. `feedback.submit` atomically publishes selected saved drafts and records the decision against a checkpoint. It does not need an agent to be online. Authors query submitted feedback and respond through the ordinary API.

Ask saves a question and frozen context before launch. A fresh local harness receives read/answer-scoped API access, not author permission. Completed answers are durable; failed launches and interrupted runs remain visible and can be explicitly retried. Do not promise automatic process recovery, partial-answer streaming, cancellation or transcript forking.
