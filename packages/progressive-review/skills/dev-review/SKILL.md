---
name: dev-review
description: Answer product questions about Review Desktop, or author and publish a JSON Review for a branch, jj change, or pull request.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# dev.fast Review

Author through the running Desktop's Review Host. JSON nodes, definitions, retained evidence, maps, checkpoints and conversations belong to that host. Never read or write Review document files, databases, Git notes or generated bundles.

## Product questions

Read the bundled [documentation index](docs/README.md) and relevant pages. In a source checkout, use the [source documentation](../../../../docs/README.md) if bundled docs are absent. Answer without launching the app or creating a review unless requested.

## Before authoring

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Read [Document authoring](references/document-authoring.md) and [Component API](references/component-api.md). Read [Lifecycle and storage](references/lifecycle-and-storage.md) for pins, publication and feedback; [Trace quoting](references/trace-quoting.md) only when using supplied trace evidence.

Use available Review MCP tools. Their schemas are authoritative and are generated from the same contracts as the host. If MCP is not configured, use `review host`; do not install an integration without authorization. `review mcp` is a stdio adapter, not a second review server. Desktop must already be running. Start it explicitly only when the task calls for opening/authoring a review. In development, use this checkout's built app and CLI, never an unrelated installed build.

## Authoring flow

1. Query `capabilities` and `repositories.list`. Register the requested source repository through `repository.register({path})` if needed and permitted.
2. Query `reviews.list` and `review.get` to find an appropriate existing review. Reuse only when its binding matches the user's request; create a new review when requested.
3. Call `review.create({repositoryId,change,title,description?})`. For an exact range, use `change:{kind:"range",baseRef,headRef}` with resolved commit IDs. For architecture, use `{kind:"snapshot",ref}`. Record the returned review ID, document version, metadata version and binding.
4. Open the canvas using MCP `review_open({reviewId})` or `review host open --review <uuid>`. Send small coherent `document.mutate` commands so the reader can watch accepted content appear. Put dependent definitions and nodes in the same transaction.
5. Read source through `source.read`, `source.file`, `source.tree`, `source.diff` and `source.commits` with the observed document version. A code peek references an anchor; the host resolves and retains its evidence. Plain code is illustrative, not proof of source.
6. When maps materially help, delegate a bounded worker using `dev-review-map` if available. Give it the review ID, observed document version and exact base/head commits. The worker owns map commands only and returns map-version IDs. Do not block a useful document on optional map work.
7. Publish explicitly with `review.publish({reviewId,expectedDocumentVersion,expectedReviewVersion,mapVersions:{base,head}})`. Use `null` for absent map versions. Publication freezes the document, metadata, binding and selected maps in a checkpoint. Accepted live mutations are not publication.
8. Confirm the expected document/checkpoint through queries and inspect any `canvas.reports`. Report unavailable resources or rendering errors honestly; a successful command is not evidence that the reader has seen it.

Every mutating command requires a caller-chosen `commandId` UUID. Reuse the same ID **and identical input** after a lost response. For a genuine version conflict, refetch, reconcile, and send a new command ID. Never overwrite concurrent changes by blindly replacing the whole document.

## Feedback and Ask

Read submitted work with `feedback.list/get`, `threads.list` and `thread.get`. Private human drafts are not author-visible. Reply with `thread.reply`, update the document normally, and resolve addressed threads with `thread.status` when appropriate. Republishing remains explicit. Do not claim request changes automatically launches or resumes the author; submission persists independently of agent execution.

Ask starts a **fresh trusted local** agent with a frozen question context; it does not fork the review author. For an Ask task, follow the provided run instructions and scoped connection. Read `question.context` and the saved thread when needed. Return the answer through the supplied completion path; never switch to author credentials, mutate the document, or submit reviewer decisions. The host saves the completed answer. Posted questions and replies are immutable; corrections are follow-ups. No partial-answer streaming or Stop workflow is provided.

## Boundaries

Legacy `review.mdx`, `data.ts`, `review scaffold/publish/threads/map` workflows do not author JSON reviews. The bundled tutorial may retain trusted legacy rendering; it is not an agent-authoring template. Old user reviews are neither migrated nor deleted by this flow.

Only a trusted bundled-tutorial Ask may provide `dev-review-thread-id` and instruct you to use `review internal-thread <threadId>`. That utility requires the attached tutorial thread credential and cannot read ordinary JSON reviews. Follow its read-only prompt; do not use it as a general discovery or authoring path.

Do not run repository tests, typechecks or lints merely to write a review unless the user requested those checks. Explain the code and cite evidence; do not turn authoring into an unrelated implementation task.
