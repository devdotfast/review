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

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Use Review’s tools to read and edit Reviews. Follow their descriptions for tool usage. Read the [authoring guidance](references/document-authoring.md) before writing.

When `review_capabilities` reports `authoringMode:"batch"`, follow [Batch Review authoring](../dev-review-batch/SKILL.md) instead of the live workflow below.

## Live authoring

1. Create a Review for the subject the user requested, or open the existing Review they want updated.
2. For a new Review, create the full outline early, then fill each section with explanations, examples and diagrams. For an update, preserve the existing structure unless the requested work calls for reorganizing it. Make progress visible through small, meaningful edits.
3. Read each filled section with `review_get({reviewId,targetId})` and apply the shared [section checks](references/document-authoring.md#check-each-section) before moving on. Fix issues in place, then mark the section complete.
4. Read the entire saved Review with `review_get({reviewId,full:true})` and perform the shared [self-review](references/document-authoring.md#self-review-before-completion). Correct issues and reread affected content. Confirm all intended sections are saved and complete, then end the authoring session according to the tool instructions.

## Make progress visible

The user sees the document as you write it. Add explanations, examples and diagrams as they become ready, aiming for visible additions every few seconds while writing. Write complete, useful pieces rather than holding the whole document until it is finished or making empty edits to meet a timer.

Keep the activity indicator focused on the section you are working on, including while investigating its code. Update the focus when moving to another section. Activity updates show ongoing work; document edits show actual progress.

Revise existing sections and components in place, preserving their IDs. Use targeted edits to fix problems instead of deleting and rebuilding the document.
