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

## Outline first, then fill in

Make the review readable at a glance before adding detailed content. First insert the landing summary and the planned sections, each with a heading and a short description grounded in what you already know. Use `section` nodes with `status:"pending"` and a brief `markdown` child. These descriptions should explain the change, not say “TODO” or pretend evidence has been verified. Keep the outline proportional to the change; a small review may need only a summary.

Before filling a section, patch it with `changes:{status:"in_progress"}`. Then fill each section in place, using the returned IDs and `parentId` to add evidence, examples or diagrams. Preserve existing section IDs instead of replacing the whole review. Revise the outline if source verification changes your understanding, and remove sections that prove unnecessary. Do not build empty diagrams or invalid components as placeholders. After checking a section’s content, patch it with `changes:{status:"complete"}`. If revising a completed section, mark it in progress again before editing. Parent and child section statuses are independent; complete a parent only after its intended children are complete.

Section status is saved with document versions and remains visible when activity stops. An absent status means unspecified, not complete. Ending a lease never completes sections. If interrupted, leave unfinished sections pending or in progress; use `review_get` to find them when resuming.

Report the current work through `review_activity`: begin with `focus:{description:"Drafting the review outline"}`, then renew with a section's returned `targetId` and a short description such as “Adding the save-flow example.” Update this focus before starting work on a different section. Heartbeat renewals may omit focus to keep it; `focus:null` clears it for general work such as final checks. End the lease when finished or after an error. This transient signal identifies unfinished work without putting progress messages in saved review prose.

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

Use this example only when it fits the change. A step takes exactly one of `explanation`, illustrative `code:{language,text}`, or a verified `source:{file,start:{side,line},end:{side,line}}`. A `source` must cover visible code; a whitespace-only range is rejected. Read the tool schema for the other components.

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

A `code_peek` contains a `source` in the same `DiffSelection` endpoint format as lens attachments. It displays the selected interval of the aligned diff. For a prose link, use `[save logic](review-source:head/src/save.ts#L10-L24)` (or `base`). A single line uses `#L10`; URL-encode spaces and reserved characters in the repository-relative path. The host validates the range before saving (a prose link may point at blank lines), and the link opens the existing native side peek at that version's pins. Reference-style Markdown links work too. Ordinary web links still open externally.

Upload retained resources with `review_upload`. Set `kind` to `"image"` with `base64`, `"trace"` with `trace:{label,events:[{id,role,text}]}`, or `"map"` with `pins`, `side` and `model`. A trace quote references the returned resource ID, an event ID and an exact excerpt. Use only supplied evidence; do not invent a transcript or provenance.

The host checks component shape, relationships and changed source/resource references before saving. Rejected edits leave the previous version intact. Read the returned validation details and correct the input. Nothing compiles MDX or TypeScript; there is no separate client validation, publish or render acknowledgment.

### Software-map uploads

Call `review_upload({id,repositoryId,kind:"map",pins,side:"head",model})`, using a fresh UUID for `id` and resolved pins for the same repository. For example, `model` can be:

```json
{
  "people": { "user": { "label": "User" } },
  "systems": {
    "app": {
      "label": "App",
      "containers": {
        "api": { "components": { "handler": {} } },
        "db": {}
      },
      "relationships": [
        {
          "kind": "semantic",
          "from": "api",
          "to": "db",
          "label": "Stores data"
        }
      ]
    }
  },
  "relationships": [
    { "kind": "semantic", "from": "user", "to": "app", "label": "Uses" },
    { "kind": "semantic", "from": "app.api.handler", "to": "app.db" }
  ]
}
```

- Object keys supply local IDs. Nesting builds full paths: `app`, `app.api`, `app.api.handler`. Do not repeat the parent path in a child's ID. IDs must be unique among siblings. Arrays also work; give entries explicit local `id` values so paths do not depend on array positions.
- Relationship endpoints must resolve to existing elements or data-store schema paths. Within an element's `relationships`, lookup tries that element's path plus the endpoint, then its parent's path plus the endpoint, then the endpoint as a full path. `"."` refers to the containing element. Full paths are usually clearest; relative names such as `api` and `db` above also work.
- Root `relationships` use full paths, including the single-segment IDs of people and systems. External systems belong in `systems` with `external:true`. Endpoints need not be direct children or at the same level; the second root relationship above crosses levels.
- A map element's code ranges go in `codeElements` with `sourceRanges:[{file,fromLine,toLine}]`. Files are repository-relative; line numbers are positive, inclusive, ordered and checked at `pins[side]`.

Insert a `software_map` node referencing the returned resource ID. Rejected uploads save nothing: fix the reported input and retry with the same ID. After a successful upload, that ID is immutable; changed content needs a new upload ID so old review versions keep their original map.

### Flow diagrams and diff lenses

Use `flow_diagram` for an authored flat graph. Nodes have local `key` values,
`label`, optional `description` and `kind` (`process`, `decision`, or `terminal`),
and `attachments:[{label,sources:[DiffSelection,...]}]`. Edges use `from`, `to`, optional
`label`, and optional `style` (`solid` or `dashed`). The block takes `title`,
optional `description`, and optional `direction` (`right` or `down`). Node keys
must be unique and edge endpoints must exist. Cycles are allowed.

Attach several pieces of code to a node when they support one concept. Use
empty attachments for conceptual nodes. The app computes change rings from
changed lines inside attached diff selections, deduplicating overlaps. A selection
covers the interval between its endpoint rows in the existing alignment,
including both sides and any one-sided rows inside. Do not author counterpart
ranges, counts, or colors. Selecting a node opens its code peeks.

Saved source-bearing diagrams appear in the Diff sidebar. Expanding a diagram
activates its lens; clicking a diagram element scrolls to that element's diff
section. Collapsing the lens restores the full comparison. These are pinned
ranges, not symbol matching across revisions. Viewed state is shared code
coverage across overlapping files, sections and diagrams; marking code viewed
does not create authored document versions.

### File lenses

Use `file_lens` for named groups containing whole changed files, pinned ranges, or both:

```json
{
  "type": "file_lens",
  "title": "Parser and tests",
  "targets": [
    { "kind": "files", "patterns": ["**/*.test.ts"] },
    {
      "kind": "ranges",
      "sources": [
        {
          "file": "src/parser.ts",
          "start": { "side": "head", "line": 40 },
          "end": { "side": "head", "line": 85 }
        }
      ]
    }
  ]
}
```

File patterns match only changed files, including either path of a rename. Diff
selections identify endpoints using one-based lines at the review's base or head
pins and can reference unchanged files. The inclusive interval in the uncollapsed
alignment covers both additions and removals inside. All targets are unioned; overlaps never double-count changed lines.
Whole-file targets subsume narrower targets for the same file.

Counts and viewed actions apply only to selected changed lines. Range lenses
show surrounding context and fold code outside the selection; that context does
not add coverage. File lenses appear only in the Diff sidebar and activate
without expanding a diagram. Empty lenses remain visible, disabled, with zero
files. Existing `patterns` lenses remain supported as whole-file selections;
new lenses should use `targets`, never both fields.

The automatic **Uncategorized changes** lens selects exactly the changed ranges
not covered by valid authored lenses. Its count, filter and viewed actions all
use those residual ranges. Viewed state does not affect membership. Do not
author a duplicate catch-all lens.

### Diff-row selections

All code peeks and lens attachments (`source` on a code peek, call frame, sequence step or database operation,
and items in flow attachments, frame `contextSources`, or file-lens range `sources`)
use this single endpoint format:

```json
{
  "file": "src/parser.ts",
  "start": { "side": "base", "line": 38 },
  "end": { "side": "head", "line": 85 }
}
```

Each endpoint names one row in the already-computed alignment using either side's
one-based line number. The interval is inclusive and independent of split/unified
layout or fold state. Endpoints must exist and appear in alignment order, even if
the starting line number is greater than the ending line number. A selection may
start on a deletion-only row and end on an insertion-only row. Use the same side
at both endpoints for a function or ordinary code range. Multiple attachments
select disjoint intervals. Surrounding display context is not included in counts,
coverage, or viewed actions. There is no source-range shorthand or paired-coordinate
endpoint form for document attachments. Low-level source quoting APIs still read one revision; they are not document authoring inputs.
