---
name: scratchpad
description: Draw on the Review scratchpad to explain code visually — diagrams, call trees, code peeks from any repository, and hyperlinked prose — when the user asks to be shown how something works, wants a picture of a flow or structure, or is thinking through a design with you before there is a plan. Use instead of ASCII diagrams in chat when Review Desktop is running.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# Scratchpad

The scratchpad is one document in Review Desktop that is not a review of any change. It has no target, base, head or lifecycle. You draw on it the way you would sketch an explanation on a whiteboard: a short paragraph, a sequence or flow diagram, a call tree, a code peek, and the smallest view that makes the point. The user reads it in the app and copies blocks back to you.

Its id is fixed: `scratchpad`. It always exists; never create, rename, delete, dismiss or share it.

## When to draw here

- The user asks to be shown how something works, wants a picture of a flow, a call path, a data shape or a layout, or is thinking out loud with you before there is a concrete plan.
- The explanation spans more than one file or more than one repository, or would be an ASCII diagram in chat.

Answer in chat when one sentence or one code line does it. Do not use the scratchpad to review a change; author a review with the dev-review skill instead.

## How

1. `review_capabilities({})`. Draw only when `desktopAvailable` is true and `authoringMode` is `interactive`. Otherwise answer in chat. Read the shared [authoring guidance](../dev-review/references/document-authoring.md) for component selection and source verification; follow this skill for scratchpad structure and completion. Read user guidance at `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`) and each relevant repository's root `DEV-REVIEW.md` when present; repository guidance takes precedence for that repository.
2. Every source reference names its own pins. For each repository you will quote, `review_register_repository({path})`, then `review_resolve_pins({repositoryId, base: "HEAD", head: "HEAD"})` (or the commit the user is looking at) to get commit ids. Put `pins: {repositoryId, head}` on each `code_peek` source, sequence step source, flow attachment source, call-stack frame source and database operation source; add `base` only when the block compares two commits. Put the same `pins` on a `markdown` block so its `review-source:` links resolve there. A reference without pins is rejected, since the scratchpad has none to lend.
3. Read what you cite with `review_file`, `review_tree` or `review_source`, using `reviewId:"scratchpad"` and those pins: pass `repositoryId` and `head` (and `base`) to `review_file` and `review_tree`, or `source.pins` to `review_source`.
4. Begin `review_activity({reviewId: "scratchpad", action: "begin", leaseId})` with a fresh UUID. Maintain the lease and pass it on edits according to the tool descriptions. Insert blocks with `review_edit`, supplying `reviewId:"scratchpad"`, `leaseId` and a fresh `commandId`. Omitted placement puts the block at the top of the pad, and the response's `targetId` names it. A thought that spans several blocks reads top-down only if you insert it bottom-up (last block first) or give each following block `afterId` of the block you just inserted. Draw a diagram whole in one insert; fix one you drew earlier by patching its nodes, edges or steps by ID, and `replace` a block only when the whole picture was wrong. Follow the edit tool's description for component mechanics; full-Review outlines and section statuses do not apply here.
5. After your first insert in a session, `review_open({reviewId: "scratchpad"})` once so the pad is showing. Do not call it again for later edits; they appear live.
6. Read each new or changed block with `review_get({reviewId:"scratchpad",targetId})`. Check its explanation, component choice, diagram data and source references against the shared guidance; correct issues and reread affected blocks. End the lease after verification.
7. In chat, say in one line what you drew. Do not repeat the diagram there.

Keep it a log, not a document: the newest thought sits at the top, above older ones. Do not build sections, outlines or status markers unless the user asks for structure. When the user asks to clear the pad, `replace` or `remove` its blocks; history keeps what was there.
