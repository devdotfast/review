---
name: dev-review
description: Create and update Reviews.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# dev.fast Review

Use Review’s components to explain the subject the user asked about.

## Before authoring

Call `review_capabilities` first. When `authoringMode` is `batch`, follow [Batch Review authoring](../dev-review-batch/SKILL.md). Otherwise, use the interactive workflow below, including when Desktop is unavailable.

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Use Review’s tools to read and edit Reviews. Follow their descriptions and schemas (`review api tools` lists them for CLI callers). Read the shared [authoring guidance](references/document-authoring.md) before writing for planning, component selection, source evidence and self-review.

## Interactive authoring

If pinned source navigation in Desktop needs dependencies or generated files, read [Prepared worktrees](references/prepared-worktrees.md) before opening the Review.

1. Create a Review for the subject the user requested, or locate the existing Review they want updated. Call `review_open` only when `desktopAvailable` is true.
2. Begin an authoring session with `review_activity` before editing and maintain it according to the tool description. For a new Review, create the full outline early, then fill each section with explanations, examples and diagrams. For an update, read the saved Review and preserve its structure unless the requested work calls for reorganizing it. Make progress visible through small, meaningful edits.
3. Read each filled section with `review_get({reviewId,targetId})` and apply the shared [section checks](references/document-authoring.md#check-each-section) before moving on. Summarize your assessment in a brief progress update. Fix issues in place, then mark the section complete.
4. Read the entire saved Review with `review_get({reviewId,full:true})` and perform the shared [self-review](references/document-authoring.md#self-review-before-completion). Correct issues and reread affected content. Confirm all intended sections are saved and complete, then end the authoring session according to the tool instructions.

## Make progress visible

Interactive edits save immediately. When a reader is watching in Desktop, add explanations, examples and diagrams as they become ready, aiming for visible additions every few seconds while writing. Write complete, useful pieces rather than holding the whole document until it is finished or making empty edits to meet a timer.

Write small and often while a reader may be watching: one paragraph per edit, so the document draws itself as you go. A new diagram is one edit: insert the whole `flow_diagram` or `sequence` with all its nodes, edges or steps, and the board traces it in one quick pass. Change a diagram already on the board one unit at a time: insert, update or remove its nodes, edges and steps by ID. Wire as you go when adding nodes: insert each with `link:{from:"<node already drawn>"}` (or `to`) so it arrives attached, and use a separate `flow_edge` only between nodes that already exist. Never leave a pile of unconnected nodes; that is not how anyone draws on a whiteboard.

Keep the activity indicator focused on the section you are working on, including while investigating its code. Update the focus when moving to another section, and set it on a block before rewriting that block, so the reader sees where you are before the change lands. Activity updates show ongoing work; document edits show actual progress.

Revise existing sections and components in place, preserving their IDs. Use targeted edits to fix problems instead of deleting and rebuilding the document.
