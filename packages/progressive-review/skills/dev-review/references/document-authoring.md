# Document authoring

## Reader contract

The reader may not have your coding transcript. Explain the change in plain language; introduce abstractions before naming their implementation details. Put the outcome first, then use progressive disclosure.

Set a short, specific review title through `review.create` or `review.update`; a heading node does not change metadata. Open with a concise summary and why the change matters. Add only sections that help the reader check important claims: requirements, interfaces, data flow, storage, tradeoffs, or focused testing evidence.

Prefer typed source links for evidence and code peeks where seeing the code matters. Use sequence, call-stack, database or software-map views only when they explain a relationship more clearly than prose. Describe what a test verifies; do not fill the review with passing-test counts. Do not invent risks that depend on unknown product usage.

Use supplied user words for intent when appropriate. [Trace quoting](trace-quoting.md) explains how to retain those excerpts; an author transcript is never required.

## Canonical authoring

The document is JSON:

```json
{
  "schemaVersion": 1,
  "roots": ["intro"],
  "nodes": {
    "intro": { "id": "intro", "type": "markdown", "markdown": "A concise explanation." }
  },
  "definitions": {}
}
```

The host adds the document/review IDs, version, exact binding, content hash and retained evidence to query results. Do not send those state fields as authored document input.

`document.mutate` applies an ordered operation list atomically. Stable IDs identify nodes; titles and labels may repeat. Section/callout children are node IDs, not nested JSX. A node has exactly one place in the tree. Use `node.move` to reorder it; keep its ID so the viewer can preserve local state.

Add an anchor and its peek together:

```json
{
  "reviewId": "<review UUID>",
  "expectedDocumentVersion": 0,
  "operations": [
    {
      "op": "definition.put",
      "id": "publish",
      "value": {
        "kind": "anchor",
        "title": "Publication",
        "source": { "side": "head", "file": "src/publish.ts", "fromLine": 40, "toLine": 66 }
      }
    },
    {
      "op": "node.insert",
      "node": { "id": "publish-peek", "type": "code_peek", "anchorId": "publish" },
      "placement": { "parentId": null, "afterId": null }
    }
  ]
}
```

Replace the illustrative path/range with source verified at the returned binding. Supply `commandId` as an additional MCP argument, or the CLI's `--command-id` flag.

## Source and validation

Read exact source through `source.read({reviewId,documentVersion,range})`. Paths are repository-relative; `side` chooses the version's pinned base or head. The host rejects missing/out-of-bounds, binary, symlink and oversized source. It retains accepted quotations with commit/blob IDs. A later unavailable checkout must not invalidate saved evidence.

Every mutation checks shape, limits, tree integrity and references. Changed nodes and affected dependents receive semantic/evidence validation. Failures leave the prior version intact. Optional `document.validate` previews the same proposed operations without committing. Neither operation compiles MDX or TypeScript.

Read [Component API](component-api.md) for node shapes, [Source availability](prepared-worktrees.md) when source cannot be read, and [Lifecycle and storage](lifecycle-and-storage.md) before repinning or publishing.
