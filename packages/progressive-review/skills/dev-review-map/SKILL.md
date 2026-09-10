---
name: dev-review-map
description: Author and save pinned JSON software-map versions for a Review through its host API.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# Review software-map worker

Use the running Review Host's MCP tools or `review host` commands. Map state is versioned JSON in the host, not Git notes, TypeScript scratch files or generated source-branch files.

Obtain the review ID, observed document version and exact binding from the parent or `document.get`. Author the base structure first, then the head structure. If asked directly and no review exists, ask for/select the intended review before creating map state; do not invent repository bindings.

## Model

`map.create({reviewId,documentVersion,side,map})` accepts:

```json
{
  "schemaVersion": 1,
  "elements": {
    "desktop": {
      "id": "desktop",
      "parentId": null,
      "label": "Review Desktop",
      "description": "Local review host and viewer.",
      "kind": "system",
      "source": []
    }
  },
  "relationships": {}
}
```

Element kinds: `person,system,container,component,code,store`. Use stable letter-led keys containing letters, numbers, underscores or hyphens, not dot paths. Define hierarchy using `parentId`.

Source spans name `repositoryId,commit,blob,file,fromLine,toLine`. Obtain them from host source reads at the selected side; the host verifies them. Store elements can carry the typed collection/field model exposed in the MCP schema.

Relationships have `id,fromId,toId,label` and either:

- `kind:"call", evidence:<verified source span>`; or
- `kind:"semantic", explanation:<why the relation exists>`.

Do not fabricate a source-backed call to represent a conceptual relationship.

## Workflow

1. Inspect the important boundaries at the pinned base using source queries.
2. Create a base map; correct reported shape, hierarchy, evidence or layout errors.
3. Inspect the pinned diff and create a head map with stable element identities.
4. Read both exact versions through `map.get({reviewId,mapVersionId})`.
5. Return the base/head map-version IDs, commits and any limitations.

To revise a map, use `map.mutate({reviewId,mapId,expectedVersion,operations})`. Operations are `element.put/remove` and `relationship.put/remove`; inspect the advertised schema for exact fields. The result is a new immutable map version.

Every command needs a UUID `commandId`; reuse it with identical input after an uncertain response. Resolve actual version conflicts before sending a new command.

The main author owns document mutations and `review.publish`, including selected map-version IDs. Do not publish or alter document nodes as a map-only worker. A missing optional map need not block a useful document checkpoint. Do not run repository tests merely to produce a map.
