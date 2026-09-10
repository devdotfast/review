# Lifecycle and storage

## One owner

Desktop runs one local HTTP Review Host. UI, CLI and MCP use the same commands, queries and events. The shared `$DEV_REVIEW_HOME/review-host.db` (default `~/.dev/review-host.db`) owns reviews, immutable document versions/evidence/maps, resources and checkpoints. Its schema and filesystem layout are implementation details, not a client API.

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

Document and review metadata versions are independent. Use the relevant expected version for each write. A metadata update or another review's edit does not invalidate the document version.

Commands use caller-chosen UUID receipt IDs. Retry an uncertain result with the same ID and input. A changed request needs a new ID. Refetch and reconcile real conflicts.

`review.publish` checks the expected document and metadata versions and freezes an immutable checkpoint with exact selected map-version IDs (or `null`). Maps can be authored independently; publish another checkpoint when the selection changes. There is no separate Git-note or map-bundle publication.

| Workflow | Meaning |
| --- | --- |
| `draft` | Not yet published |
| `in_review` | Published for a reviewer |
| `closed` | Closed by an explicit human action; explicit reopen is required |

Live views receive atomic committed events. Historical checkpoint views ignore working-document updates. Render reports are observations of a version, not the server's commit gate.

## Conversations are deferred

Comments, feedback submission and Ask are unavailable for JSON reviews in this authoring-only version. They are deferred to the third PR in this stack. No draft, thread, feedback or question operations are exposed by
the JSON host. Do not use legacy files or commands as a substitute. Ordinary
authoring, repinning and checkpoint publication remain available.
