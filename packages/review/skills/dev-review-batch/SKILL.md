---
name: dev-review-batch
description: Author one finished Review version through an explicitly selected batch server, using scratch drafts and an atomic commit. Use when Review capabilities report authoringMode batch.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# Batch Review authoring

Use the running Review server through MCP tools or `review api <tool-name> '<json>'` (use `-` for JSON on stdin). Call `review_capabilities` and require `authoringMode:"batch"`; Desktop availability does not select the workflow. The caller supplies the agent, prepared checkout, and explicit base/head revisions. Setup examples are in [Headless authoring](../dev-review/references/headless-authoring.md).

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present; repository guidance takes precedence. Use the shared [document and component reference](../dev-review/references/document-authoring.md) for writing quality, supported components and source evidence. Its interactive-only outline/status instructions do not apply here. Never edit Review's database or files directly.

1. Register the prepared checkout with `review_register_repository({path})` and resolve `review_resolve_pins({repositoryId,base,head})`. Missing commits must be fetched by the caller. For architecture reviews, use the same revision for both sides.
2. Begin with `review_draft_begin({title,pins,pullRequestUrl?})`, or supply `reviewId` to update an appropriate existing review from its last committed version. Retain the returned `draftId`. A new draft has no committed placeholder. A conflict means another author owns the review; do not take over their session.
3. Reuse known change context and verify the evidence you need. In batch mode, `review_source`, `review_file`, `review_tree`, `review_diff` and `review_commits` take `draftId`. `review_upload` retains images, traces and maps before the review is committed. Generate optional maps only when capabilities permit it.
4. Prefer `review_draft_write({draftId,document,...})` to write substantial content or the entire document. Omit component IDs: the server allocates fresh IDs on each bulk replacement. Read returned IDs or `review_draft_get({draftId})` and use `review_draft_edit({draftId,edit})` for targeted corrections and cross references. This reuses the normal edit language. Scratch writes persist without creating history. No activity, heartbeat, focus or section-status transitions are needed.
5. Inspect the draft's substance and source evidence, then call `review_draft_validate({draftId})`. Correct errors in the same draft. Validation checks structure and references; it does not prove that claims are accurate or prose is useful.
6. Call `review_draft_commit({draftId,commandId})` with a fresh UUID. Retry that exact input after a lost response. Commit validates again, marks every section complete and saves one version atomically. Return the committed review ID and version. When Desktop is available and opening is requested, use `review_open` after commit.

On an intentional failure path, call `review_draft_abort({draftId})`. This discards scratch work and preserves the last committed version. The server owns the lock until commit, abort or server shutdown; an agent disconnect does not release it. CI must stop its server during teardown. Abandoned drafts are discarded after server death, with no resume, rebase or merge. Ordinary review reads expose only committed content.
