---
name: dev-review
description: Answer product questions about Review Desktop, or author a JSON Review for a branch, jj change, or pull request.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# dev.fast Review

Author a short Review through the running desktop server. The server owns JSON content, saved versions, source pins, resources and comments. Never read or write Review files, databases, Git notes or generated bundles.

## Product questions

Read the bundled [documentation index](docs/README.md) and relevant pages. In a source checkout, use the [source documentation](../../../../docs/README.md) if bundled docs are absent. Answer without launching the app or creating a review unless requested. Older documentation may describe MDX reviews; the API workflow below is for JSON reviews.

## Before authoring

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Read [Document authoring](references/document-authoring.md) for writing guidance and JSON examples. The MCP tool schemas come from the running server and describe all supported components.

Use available Review MCP tools. Otherwise use `review api <tool-name> '<json>'`, or `review api <tool-name> -` with JSON on stdin. `review api tools` returns the same tool schemas. `review mcp` is a stdio adapter, not another review server. Do not install an integration without authorization.

In development, use this checkout's built CLI: from its root, `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1 node packages/review/dist/cli.js api …` (or `mcp`). Build the checkout first if that entry is absent or stale. Set `DEV_REVIEW_HOME` to the profile used by this checkout's app. Use the checkout-built app, not an unrelated installed Preview build. Desktop must be running; start it explicitly when the requested task calls for opening or authoring a review.

## Authoring

1. Use `review_register_repository({path})` to get the repository ID, then `review_resolve_pins({repositoryId,base,head})` to resolve immutable commits. For an architecture review, use the same revision for both sides.
2. Check `review_list` for a review matching the user's requested comparison. Reuse only when appropriate. Use `review_create({commandId,title,pins})` when a new review is needed or requested.
3. Show it with `review_open({reviewId})`. Send small coherent `review_edit` calls so accepted content appears as you work. Components contain their own data; there is no separate definitions table.
4. Reuse implementation context already in the conversation. Verify only the source needed for your claims with `review_source`, `review_file`, `review_tree`, `review_diff` or `review_commits`. Supply `version` when reading a historical snapshot.
5. Use `review_upload` for images, supplied trace excerpts or software maps. The upload tool's schema is authoritative. Insert a `software_map` node with the returned resource ID for each desired side. Maps are optional when they do not help explain the change; do not delay useful prose for them. The old Git-notes map commands do not update JSON reviews.
6. Check the outline with `review_get({reviewId})`, one target with `targetId`, or all content with `full:true`. Every accepted edit is saved; there is no publish, checkpoint or render-report step. Inspect the real UI when visual verification is requested.

Create/edit/rename/repin/restore, feedback, attention and delete require a `commandId` UUID. Reuse it with identical input after a lost response. The server assigns short durable node IDs; use returned IDs for later edits. There is no `expectedVersion`. Missing or incompatible targets produce errors; later same-field edits win. Avoid replacing the whole document to make a small change.

While authoring, call `review_activity({reviewId,action:"begin",leaseId})` with a fresh UUID. Renew that lease at least every 30 seconds while work continues, and send `action:"end"` when finished, including after an error. This reports work without changing the review or locking edits; it expires after 60 seconds without renewal. Use a new lease after expiry. There is no “applying update” state.

## Versions and feedback

`review_repin({commandId,reviewId,pins})` starts a blank version at new source pins. Examine the diff before carrying content over. `review_restore({commandId,reviewId,version})` restores title, pins and content; it does not roll back comments.

Use `review_threads` to read saved conversations and submissions, and `review_feedback` to reply or resolve an addressed thread. Posted messages are immutable; corrections are follow-ups. Draft saves and review submissions are explicit user actions, not something an author should perform on a reviewer's behalf.

Ask starts a fresh installed local agent from saved review/question context. Request changes starts one agent for the submitted comments; it may edit the review through the API. The host saves completed answers, including terminal follow-ups. Running work is not resumed after Desktop restarts; saved questions and answers remain. Legacy `review scaffold/publish/threads/map` commands do not operate on JSON reviews.

Do not run repository tests, typechecks or lints merely to write a review unless the user requested those checks. Explain the code and cite evidence; do not turn authoring into an unrelated implementation task.
