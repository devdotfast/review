---
name: dev-review-batch
description: Author a finished Review in batch mode. Use when review_capabilities reports authoringMode batch.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# Batch Review authoring

Use Review’s MCP tools or `review api <tool-name> '<json>'` (`-` reads JSON from stdin). Confirm `review_capabilities` reports `authoringMode:"batch"` and follow the tool descriptions and schemas (`review api tools` lists them for CLI callers).

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present; repository guidance takes precedence. Read the shared [authoring guidance](../dev-review/references/document-authoring.md) before writing for planning, component selection, source evidence and self-review.

1. For a new Review, use the resolved pins supplied by the caller.
2. Begin a draft with `review_draft_begin`, including the supplied PR URL when present. For a requested update, supply `reviewId` and read the draft before editing; follow the tool description when changing pins or converting a worktree target. Retain `draftId` for source reads and subsequent draft tools.
3. Investigate the pinned source and plan the explanation using the shared authoring guidance.
4. Use `review_draft_write` for a new document or substantial rewrite; use `review_draft_edit` with returned IDs for targeted updates, corrections and cross references. Read the content with `review_draft_get` and apply the shared [section checks](../dev-review/references/document-authoring.md#check-each-section).
5. Read the full draft and perform the shared [self-review](../dev-review/references/document-authoring.md#self-review-before-completion), then call `review_draft_validate`. Correct issues in the same draft and reread affected content before validating again.
6. Commit one finished version with `review_draft_commit` and a fresh `commandId` UUID. Retry the same input after a lost response. Return the committed review ID and version.

If abandoning the draft, call `review_draft_abort`.
