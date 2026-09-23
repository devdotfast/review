# Authoring guidance

## Plan the explanation

Start with the subject and scope the user requested. A Review may explain existing code, an architecture, a workflow or a proposed or implemented change. Use comparisons when the subject calls for them.

Identify the questions the Review needs to answer. For example: how a request is handled, where data lives, how responsibilities are divided, or why a design was chosen. Inspect the relevant code and use the answers to form the outline.

Give a new Review a specific title. Open with a brief overview, then organize sections around the main concepts or questions. Use descriptive headings such as “How a payment is retried” or “Where session data is stored.” Create the whole outline before filling sections so you can check that it covers the subject. For an update, read the existing Review first and identify the sections and diagrams affected by the request; preserve the rest.

### Default structure for change reviews

When reviewing a change, use these sections in this order unless the user requests a different structure. Other Review types can follow the concepts or questions outlined above.

1. **What / why:** What changes, what problem it solves, and why it matters. Describe the relevant previous and new behavior.
2. **Design:** How the solution works, the main decisions and tradeoffs, with diagrams that explain the relationships involved.
3. **Requirements:** The behavior and constraints the change must satisfy, including important edge cases. Distinguish stated requirements from inferred expectations.
4. **Implementation:** How the code delivers the design and meets the requirements, using focused source links and diffs. Identify any requirements the implementation leaves unmet.

Use retained trace decisions as evidence for why an approach was chosen or an alternative rejected; include a `trace_quote` when the actual excerpt helps. Verify what was implemented against the current code, since trace intent may differ from the final implementation.

## Write the explanation

The overview is a starting point. Follow it with enough detail to explain how the subject works:

- Walk through the important behavior from its trigger to its outcome. Name the participants, the work they perform and the data they pass or store.
- Use concrete examples. For a retry mechanism, show what happens to a particular failed request, including what causes it to stop retrying.
- Explain design decisions and tradeoffs when there is evidence for them. Distinguish documented reasons from your interpretation.
- Explain boundaries, failure paths and constraints that materially affect the behavior.
- Link to the code that supports the explanation using `[label](review-source:head/src/file.ts#L10-L24)` (or `base` for the previous revision). Use repository-relative paths and line numbers verified with the source tools; a single line uses `#L10`. Encode spaces in paths as `%20`. Relative Markdown file links, absolute filesystem paths, and file/editor URLs are rejected during validation and commit. External links use `https://`, `http://`, or `mailto:`; document anchors use `#heading`. Include relevant existing test evidence and distinguish it from checks actually run.

Choose depth according to the subject's complexity. A small function can encode an important invariant that needs a full explanation. Cover each major question in the outline in the initial completed Review; expand sections that only list symbols, files or one-line descriptions.

Use direct language and define terms when introducing them. Explain the meaning of a diagram in the surrounding prose. Give each section a distinct purpose and remove repetition.

When explaining a change, show the relevant previous and new behavior. When explaining existing architecture, describe its current responsibilities and interactions. Avoid inventing history, requirements or rationale to fill a section.

## Choose components

Choose the component that makes the relationship visible. Use native diagram components for interactions, control flow and storage; use tables for comparisons of independent properties.

| What you need to explain | Component | How to use it |
| --- | --- | --- |
| Participants interacting over time | `sequence` | Show calls, responses and asynchronous handoffs in order. For a save operation, show the caller, service and store, and when each acts. |
| Concrete execution paths | `call_stack_diff` | Compare source-backed call paths, such as the old and new route through functions. Use a sequence for interactions between actors. |
| Branching, retries or state transitions | `flow_diagram` | Use labeled edges to show decisions, alternate outcomes and cycles. |
| Stored data and its readers/writers | `database_lens` | Show stores, tables or collections, relevant fields and relationships, plus read/write use cases linked to code. |
<!-- software-map-start -->| System structure and responsibilities | `software_map` | Show boundaries, ownership and dependencies among systems, containers and components. |<!-- software-map-end -->
| Options or properties to compare | A table in `markdown` | Compare tradeoffs, configuration values, compatibility or input/output cases. A sequence is the appropriate choice for a table whose rows describe messages passed between participants. |
| Implementation worth examining inline | `code_peek` | Show the code that demonstrates a mechanism or supports a claim. Use source links for other citations. |
| Illustrative usage or pseudocode | `code` | Make clear that the example is illustrative. |
| Code grouped by concern | `file_lens` | Group relevant files or ranges for navigating the code alongside the explanation. |
| An interface or other visual evidence | `image` | Use an available image that illustrates the point and explain what to notice. |
| A supplied statement of intent or reasoning | `trace_quote` | Quote an actual retained trace excerpt. Keep the surrounding explanation understandable on its own. |

A single subject can need several views. A sequence can show when a transaction occurs, while a database view shows the data it reads and writes. Give each view a distinct job.

When a diagram supports attaching evidence, always attach evidence. In order of preference: concrete code evidence > pseudocode / explanation >> no attachments.

### Database views

When storage is part of the subject, inspect the data model and its access paths. Include a database view when persisted structure, relationships or read/write responsibilities are important to the explanation. This applies to existing storage designs as well as changes, and includes document and file stores.

Show the relevant stores, collections and fields, with keys and relationships that matter. Add concrete use cases identifying who reads or writes the data, with source evidence for the operations. Follow the actual callers to understand how the data is used. Label which design or revision the view represents when comparing versions.

For example, a Review of session persistence should show where sessions are stored and which operations create, retrieve or update them. A list of table names alone leaves that behavior unexplained.

Read the component schema when constructing the view. A database view requires use cases with source-backed operations; if the available code does not establish those operations, explain the evidence gap rather than inventing them.

### Diagrams

Write a new diagram whole: one insert with all its nodes and edges, or all its steps. The board traces it in one quick pass, in the order a hand would draw it. Grow or fix a diagram already on the board one unit at a time, each as its own edit with `parentId` set to the diagram's returned ID. A new `flow_node` carries the edge that attaches it: `link:{from:"<key already drawn>",label?,style?}` (or `to` when the arrow runs from the new node), so it is drawn in its final place and the edge follows it. Never leave a node unconnected while you add others; a reader cannot place an orphan. Insert a `flow_edge` on its own only between nodes that already exist. Patch a node, edge or step by its returned ID; removing a node removes its edges. Read the diagram with `targetId` to get its unit IDs.

## Check against the code

Check that prose, examples and diagrams agree with the relevant source. Verify the order of calls, branch conditions, storage operations and relationships. Source links and diagram attachments should point to the code that supports the claim at the intended revision.

Reuse knowledge from the current task, but verify the code cited in the Review. Keep illustrative examples distinct from excerpts of actual code. Identify evidence gaps where they affect the explanation.

Use existing test evidence when it helps explain behavior. Running repository tests, typechecks or linters is outside authoring unless the user asks for it.

## Check each section

After filling a section, read its content and diagram data through Review’s tools before moving on. Check the following and summarize your assessment in a brief progress update:

- **Coverage:** Does it answer the question the section sets out to explain? Expand thin content and fill missing explanations.
- **Correctness:** Do the explanations and examples match the code? Do the diagrams agree with both? Correct unsupported claims and contradictions.
- **Component choice:** Are interactions shown as sequences, storage and access as database views, and branches as flow diagrams where those relationships matter? Replace components that obscure the explanation.
- **Clarity:** Can the examples be followed from start to finish? Are terms, participants and diagram labels explained? Remove repetition and unfinished outline text.

Verify diagram labels, participants, relationships, operation order and source references from the returned text or structured data. Keep verification within these reads; do not use computer use, screenshots or UI navigation to inspect the Review.

Fix the issues found and reread the affected content and related diagrams before treating the section as complete.

## Self-review before completion

Read the entire document through Review’s tools, including every section and diagram. Reading only the outline or passing tool validation is insufficient. Section checks do not replace this whole-document pass.

Check that the Review covers the requested subject, that the sections form a coherent explanation, and that there are no gaps, repeated explanations or contradictions between sections. Check consistency of terminology and diagram participants across the document. Remove unfinished outline text.

Make targeted corrections, then reread the affected sections and related diagrams. If work remains unfinished, report it as such. Report any remaining evidence or verification limitations with the result.

No explanation at all on a diagram node (e.g. sequence diagram or flow diagram) is almost certainly a wrong choice. Only acceptable for self-evident nodes (where the title == content).
