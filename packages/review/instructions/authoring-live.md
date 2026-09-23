# dev.fast Review

Use Review’s components to explain the code the user asked about.

Unless the user explicitly asks for the scratchpad, requests to create or write a Review, or to use Review to explain something and open it, mean a regular Review document. Follow this workflow even when the scratchpad is enabled. A Review can explain architecture without reviewing a diff; use the requested repository revision as its source.

## Before authoring

Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and repository-root `DEV-REVIEW.md` when present. Repository guidance takes precedence.

Use Review’s tools to read and edit Reviews. Follow their descriptions for tool usage. Read the document authoring guidance below before writing.

## Live authoring

1. Create a Review for the subject the user requested, or open the existing Review they want updated.
2. For a new Review, create the full outline early, then fill each section with explanations, examples and diagrams. For an update, preserve the existing structure unless the requested work calls for reorganizing it. Make progress visible through small, meaningful edits.
3. Read each filled section with `review_get({reviewId,targetId})` and apply the "Check each section" checks below before moving on. Fix issues in place, then mark the section complete.
4. Read the entire saved Review with `review_get({reviewId,full:true})` and perform the "Self-review before completion" steps below. Correct issues and reread affected content. Confirm all intended sections are saved and complete, then end the authoring session according to the tool instructions.

## Make progress visible

The user sees the document as you write it. Add explanations, examples and diagrams as they become ready, aiming for visible additions every few seconds while writing. Write complete, useful pieces rather than holding the whole document until it is finished or making empty edits to meet a timer.

Write small and often while a reader may be watching: one paragraph per edit, so the document draws itself as you go. A new diagram is one edit: insert the whole `flow_diagram` or `sequence` with all its nodes, edges or steps, and the board traces it in one quick pass. Change a diagram already on the board one unit at a time: insert, update or remove its nodes, edges and steps by ID. Wire as you go when adding nodes: insert each with `link:{from:"<node already drawn>"}` (or `to`) so it arrives attached, and use a separate `flow_edge` only between nodes that already exist. Never leave a pile of unconnected nodes; that is not how anyone draws on a whiteboard.

Keep the activity indicator focused on the section you are working on, including while investigating its code. Update the focus when moving to another section, and set it on a block before rewriting that block, so the reader sees where you are before the change lands. Activity updates show ongoing work; document edits show actual progress.

Revise existing sections and components in place, preserving their IDs. Use targeted edits to fix problems instead of deleting and rebuilding the document.
