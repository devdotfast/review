---
name: whiteboard
description: Create and update Whiteboard sessions.
metadata:
  whiteboard-managed-by: "Whiteboard"
  whiteboard-generated: "Do not edit. Whiteboard automatically replaces this skill directory on updates."
  whiteboard-version: "development"
---

you are writing an interactive rfc-style review, for consumption by a staff engineer.

**flow**
- register the repository
- create the whiteboard session, pinned to the commits/pr the user describes (TODO: working tree?)
- trigger a subagent with this exact instruction: "Use the dev-file-lenses skill on session <sessionId>."
- begin `session_activity` with `scope: "document"` before editing, end it when done.
- read the diff with `session_diff`
    - immediately after reading the diff, without any other tool calls - put down a first pass at the what/why section.
- whiteboard session structure - each of these should be written as a top-level `section`, in this order:
    - what/why: succinct description of what the change is, + why the change was made (if this context is available to you.)
    - requirements: as given by the user, in their own words, if this context is available to you. otherwise, omit. write these as short bullet points
    - design: how the solution works at the level of components, data and control flow, not functions.
        - pick one diagram that best shows the shape of the change:
            - `sequence` if participants interact over time (who calls whom, async handoffs)
            - `flow_diagram` if the interesting part is branches, retries or state transitions
            - `database_lens` if the change is about what's stored and who reads/writes it
        - if the change is mostly a new/changed contract, show the key types / interfaces as `code_peek`(s)
        plus the main decisions and tradeoffs, and alternatives considered if you have evidence for them (trace, PR discussion). skip for small changes whose design is self-evident.
    - implementation: how the code delivers the design, at the level of functions and files. walk the changed code in the order a reader should follow it, starting with the entry point.
        - `call_stack_diff` for the old vs. new path through user flows. always root the flows in the user/agent entry point (eg a button click, CLI command, etc.), including unchanged nodes along the way.
        - `code_peek` for the few spots that carry the mechanism or an invariant; link everything else inline

- before finishing, read the whole whiteboard session back and fix any contradictions/unverified claims.

TODO: lenses
- lenses that cover the whole implementation diff
- other buckets - imports, tests, docs/comments

**updating existing session**
- repin
- read the existing session (if you haven't already,) read the diff since last session, make any necessary updates to the session.

**guidelines**
- IMPORTANT: Write incrementally. The user sees you write on the canvas in real-time. Show them visual progress every few seconds.
- keep reviews short and sweet when possible (esp. for small changes.) feel free to omit sections.
- when something (a phrase in the prose, diagram node, etc.) describes actual code in the codebase, always default to attaching/hyperlink code.
- check if traces are available via the trace-archaeology skill, and rewrite as much as possible of the what/why, design, and requirements sections in terms of literal trace quotes from the user.
