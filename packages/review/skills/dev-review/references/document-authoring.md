# Document authoring

## Reader contract

The reader may not have your coding transcript. Do not assume they know the agent's reasoning, implementation session, or abstractions discussed while coding. Explain the change in plain language; introduce abstractions before naming their implementation details. More words do not help. Use progressive disclosure: short prose first, then details that earn their cost. Write in ASD-STE100 Simplified Technical English (STE).

Think about the style of RFCs from Russ Cox, Dave Cheney, and the early React RFCs. Put the outcome first, not a tour of the implementation.

Set a short, specific review title through `review_create` or `review_rename`; a heading node does not change metadata. Open with a concise landing section before the detailed sections:

- **Summary:** What behavior changed, or what problem are you trying to solve? Use a couple of bullet points, no more than five. When available, quote the developer's own prompts to capture what needs to change.
- **Why:** A couple of short sentences about the problem this solves and, when relevant, what it does not try to solve. For a bugfix, explain what was wrong before; for a feature, explain what it adds. Prefer the developer's own words for intent when available.

After the landing section, use fewer than five further sections when practical. Choose only sections that fit the change:

- Requirements: use supplied user quotes as evidence.
- Design: explain significant decisions with a decision log, diagram or code example.
- Interface changes: link to code and show example usage.
- Lifecycle or data flow: use a sequence or state diagram when it makes the behavior clearer.
- State or storage: use a database diagram when it helps explain the structure.
- Testing evidence: explain what integration or end-to-end tests verify, using pseudocode when useful. Generally skip unit-test details. Link relevant testing decisions or user requirements. Do not run tests or linters merely to write the review, or report passing-test counts.

Add implementation detail only when it helps the reader check an important claim. For a small change (fewer than 300 added and deleted lines combined), a few sentences with source links are usually enough. Add a diagram only when a specific claim needs one; the section suggestions are not a checklist.

In a decision log, preserve important user requirements in the user's language and include significant implementation decisions that affect the result. When supplied trace evidence is available, use short quotes to ground the landing, requirements, design and decision log. Without it, write the same explanation in authored prose. Use retained trace resources for excerpts; an author transcript is never required.

Do not invent user-impact risks. Ask the user when a risk depends on product usage you do not know.

## Choosing source evidence

1. Reuse change context already in the conversation. If this session authored the change, skip broad re-exploration and go straight into authoring.
2. Decide which examples support the important claims.
3. Search for locations or line numbers only where needed to verify those examples at the review's pinned base or head. Use the source API described below; existing context should avoid extraneous searches, not replace checking the evidence.

Prefer source links over code peeks. Use a code peek when inline code explains the change better, such as an API usage example. Use sequence, call-stack, database or software-map views only when they explain a relationship more clearly than prose.

## Canonical authoring

Author nested JSON components, not MDX or TypeScript files. The host assigns IDs; omit IDs in new content. Sequence actors, stores and fields use component-local names, not UUIDs.

For example, call `review_edit` with:

```json
{
  "commandId": "<fresh UUID>",
  "reviewId": "<returned review ID>",
  "edit": {
    "type": "insert",
    "content": {
      "type": "sequence",
      "title": "Save an edit",
      "actors": { "agent": "Agent", "host": "Review Desktop" },
      "steps": [
        {
          "from": "agent",
          "to": "host",
          "label": "Submit an edit",
          "explanation": "The host validates the proposed content before saving it."
        }
      ]
    }
  }
}
```

Use this example only when it fits the change. A step takes exactly one of `explanation`, illustrative `code:{language,text}`, or a verified `source:{side,file,fromLine,toLine}`. Read the tool schema for the other components.

The result contains the saved version and `targetId`. Read that target to get its step IDs. To change one step, use a field patch:

```json
{
  "commandId": "<another fresh UUID>",
  "reviewId": "<review ID>",
  "edit": {
    "type": "update",
    "targetId": "step-2",
    "changes": { "label": "Validate and save" }
  }
}
```

Use an actual returned ID, not the illustrative `step-2`. Patches preserve omitted fields; null removes an optional field. Insert/move take `parentId?` and `afterId?`; omitted placement appends to the root. To insert a step, name its sequence as the parent. Replace retains the outer ID but gives new children fresh IDs. Sections and callouts contain nested `children`.

## Source, resources and validation

Read exact source with `review_source({reviewId,version?,source:{side,file,fromLine,toLine}})`; `review_file` reads a whole file. Paths are repository-relative and refer to committed base/head content, not the working copy.

A `code_peek` contains its source range directly. Use a pinned repository URL for a prose source link when available; Markdown source links with native side peeks are not connected yet. Do not turn that limitation into unnecessary diagrams or long explanations.

Upload retained resources with `review_upload`. Images take base64 bytes; traces take a provenance label and `{id,role,text}` events; maps take pins, side and the existing nested model. Use the schema to see exact shapes. A trace quote references the returned resource ID, an event ID and an exact excerpt. Use only supplied evidence; do not invent a transcript or provenance.

The host checks component shape, relationships and changed source/resource references before saving. Rejected edits leave the previous version intact. Read the returned validation details and correct the input. Nothing compiles MDX or TypeScript; there is no separate client validation, publish or render acknowledgment.
