---
name: dev-review
description: Answer product questions about Review, or author a JSON Review for a branch, jj change, or pull request through Desktop or a headless server. Use for Review capabilities, setup, CLI, CI authoring, privacy, telemetry, troubleshooting, and code-change or architecture reviews.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# dev.fast Review

Author a short Review through the running Review server. The server owns JSON content, saved versions, source pins and resources. Never read or write Review files, databases, Git notes or generated bundles.

## Product questions

Read the bundled [documentation index](docs/README.md) and relevant pages. In a source checkout, use the [source documentation](../../../../docs/README.md) if bundled docs are absent. Answer without launching the app or creating a review unless requested. Older documentation may describe MDX reviews; the API workflow below is for JSON reviews.

## Before authoring

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Use available Review MCP tools. Otherwise use `review api <tool-name> '<json>'`, or `review api <tool-name> -` with JSON on stdin. `review api tools` returns the same tool schemas. `review mcp` is a stdio adapter, not another review server. Do not install an integration without authorization.

Call `review_capabilities({})` before authoring. If `authoringMode` is `batch`, read [Batch Review authoring](../dev-review-batch/SKILL.md) and follow that workflow instead of the interactive steps below. Mode selection is explicit and independent of Desktop availability. For `interactive`, read [Document authoring](references/document-authoring.md) and continue below. The server publishes the supported component schemas. When `desktopAvailable` is true, open the review during authoring. When false, proceed headlessly. Dispatch software-map workers only when `softwareMapEnabled` is true; uploading existing maps does not require generation permission.

For headless/CI work, the caller starts `review server start` and supplies the checkout and base/head revisions. Use the caller's `DEV_REVIEW_SERVER_DIR` or `review --state-dir <path> api …` (or `mcp`) to select its server. Missing commits must be fetched by the caller. Keep the server available for subsequent steps; return the saved review ID and version when finished. See [Headless authoring](references/headless-authoring.md) for setup.

In development, use this checkout's built CLI: from its root, `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1 node packages/review/dist/cli.js api …` (or `mcp`). Build the checkout first if that entry is absent or stale. For Desktop authoring, set `DEV_REVIEW_HOME` to the checkout-built app's profile and start that app explicitly when the requested task calls for opening or authoring a review. For headless authoring, start this checkout's `server start` instead.

Read [Prepared worktrees](references/prepared-worktrees.md) only when pinned worktree dependencies or language-server navigation do not work.

## Authoring

1. Use `review_register_repository({path})` to register the intended local checkout. Choose `target:{kind:"worktree",repositoryId,base?}` to review its current saved files, or `target:{kind:"commits",repositoryId,head,base?}` for immutable commits. Revisions resolve on acceptance. Omitting the commit base means source at head with no diff (equivalent to base=head); supply its parent to review changes introduced by one commit. A worktree without base includes the whole checkout and Working changes against current HEAD.
2. Check `review_list` for a review matching the user's requested comparison. Reuse only when appropriate. Use `review_create({commandId,title,target,pullRequestUrl?})` when a new review is needed or requested. For a PR review, include its canonical GitHub PR URL (without query or fragment) so the header and stack retain its identity. To bind an existing review without resetting its content, use `review_repin({commandId,reviewId,pins,pullRequestUrl})` with its existing pins; null detaches it.
3. If Desktop is available, show it with `review_open({reviewId})`. Create the outline first with small `review_edit` calls: section headings and short, useful descriptions across the review, with `status:"pending"` on each section. Before filling a section, patch its status to `"in_progress"`. Fill it in place with verified evidence, examples and diagrams, then patch its status to `"complete"` once its content has been checked. Do not finish the first detailed section before creating the rest of the outline. Components contain their own data; there is no separate definitions table.
4. Reuse implementation context already in the conversation. Verify only the source needed for your claims with `review_source`, `review_file`, `review_tree`, `review_diff` or `review_commits`. Supply `version` when reading a historical snapshot.
5. Use `review_upload` for images, supplied trace excerpts or software maps. The upload tool's schema is authoritative. Insert a `software_map` node with the returned resource ID for each desired side. Maps are optional when they do not help explain the change; do not delay useful prose for them. The old Git-notes map commands do not update JSON reviews.
6. Confirm all intended sections are complete; leave unfinished sections pending or in progress if interrupted. Completion is a saved section status, not the end of an activity lease. Check the outline with `review_get({reviewId})`, one target with `targetId`, or all content with `full:true`. Every accepted edit is saved; there is no publish, checkpoint or render-report step. Inspect the real UI when visual verification is requested.

Before the first edit, acquire the review's exclusive authoring session with `review_activity({reviewId,action:"begin",leaseId})`, using a fresh UUID. Pass that `leaseId` on every `review_edit`, `review_rename`, `review_repin`, `review_restore`, `review_set_target` and `review_delete` call. Renew at least every 30 seconds, and send `action:"end"` when finished, including after an error. A conflict means another author owns the review: wait or work on a different review; do not take over their lease. The session expires after 60 seconds without renewal. After expiry, begin with a new UUID and reread the current review before editing. Reads and resource uploads do not require the lease. Have delegated workers return proposed content to the owning author instead of independently editing the review.

Include `focus:{description:"Drafting the review outline"}` when beginning. Before filling a section, renew with `focus:{targetId:"<returned section ID>",description:"Adding evidence to Design"}` so the UI marks the content being worked on. Omitted focus preserves it; `focus:null` clears it. Update focus when moving sections and clear it for final checks. Session renewal and release do not create document versions or complete sections.

## Versions

`review_set_target({commandId,reviewId,target})` changes source mode while retaining document and component IDs. Saved working-file changes update the live view without adding authored versions; explicit history stays immutable. Legacy `review_repin({commandId,reviewId,pins,pullRequestUrl?})` preserves the document and component IDs at the new pins. Read the returned warnings, examine the diff, and update stale source ranges and maps with `review_edit`. Range validity does not prove that a citation still supports its claim. Omitted `pullRequestUrl` preserves PR identity within the same repository; changing repositories clears it. Supply a new URL to replace it or null to detach. `review_restore({commandId,reviewId,version})` restores title, pins, PR identity and content.

Legacy `review scaffold/publish/repair` commands no longer exist. Reviews published from MDX before this release were imported into the JSON store and are edited through `review api` or these MCP tools.

Do not run repository tests, typechecks or lints merely to write a review unless the user requested those checks. Explain the code and cite evidence; do not turn authoring into an unrelated implementation task.
