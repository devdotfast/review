# JSON component API

The host accepts a closed set of JSON node types, not JSX or executable components. All shapes are strict: unknown fields are rejected. MCP input schemas are the authoritative complete contract.

Node/definition/item keys begin with a letter and contain letters, numbers, underscores or hyphens (maximum 80 characters). They are stable identities, not display labels. Review, resource and command IDs are UUIDs. Titles may repeat and multiple nodes may reuse an anchor.

## Shared definitions

Put definitions with `definition.put({id,value})` in the same mutation as nodes that reference them.

```json
{
  "publish": {
    "kind": "anchor",
    "title": "Publication",
    "source": { "side": "head", "file": "src/publish.ts", "fromLine": 40, "toLine": 66 }
  },
  "publish-base": {
    "kind": "anchor",
    "title": "Publication before the change",
    "source": { "side": "base", "file": "src/publish.ts", "fromLine": 35, "toLine": 61 }
  },
  "agent": { "kind": "actor", "label": "Agent" },
  "desktop": { "kind": "actor", "label": "Desktop" },
  "reviews": {
    "kind": "store",
    "label": "Review database",
    "storage": "relational",
    "collections": {
      "threads": {
        "label": "Threads",
        "fields": {
          "id": { "label": "ID", "dataType": "text", "nullable": false, "primaryKey": true },
          "body": { "label": "Body", "dataType": "text", "nullable": false, "primaryKey": false }
        }
      }
    }
  }
}
```

Anchor `detail` is optional. Actors may reference an exact map element using `mapElement:{mapVersionId,elementId}`. Store `storage` is `relational` or `document`; field `references` identifies `{storeId,collectionId,fieldId}`.

## Text and containers

| Type | Required fields beyond `id,type` | Optional |
| --- | --- | --- |
| `markdown` | `markdown:string` (safe Markdown/GFM) | — |
| `paragraph` | `content:Inline[]` | — |
| `heading` | `level:1..6, content:Inline[]` | — |
| `code` | `language:string, text:string` | `caption` |
| `divider` | — | — |
| `section` | `title, defaultCollapsed:boolean, children:nodeId[]` | — |
| `callout` | `tone:"info"|"warning"|"danger"|"success", children:nodeId[]` | `title` |

Inline values are `{type:"text",text,marks?}`, `{type:"code",text}`, `{type:"break"}`, `{type:"link",href,text}`, or `{type:"anchor_link",anchorId,text}`. Marks: `strong,emphasis,strike,underline,sub,sup,highlight`. External links accept HTTP(S)/mailto, not executable schemes. Raw HTML is not executed. Use typed `anchor_link` for source references and `image` for assets; do not embed remote images in Markdown.

## Code peek

```json
{ "id": "publish-code", "type": "code_peek", "anchorId": "publish", "caption": "Exact pinned source." }
```

The host retains the anchor's code. The viewer can show it even when deeper source access is unavailable. A plain `code` node is illustrative and does not assert repository provenance.

## Sequence diagram

```json
{
  "id": "publish-flow",
  "type": "sequence",
  "title": "Publish",
  "messages": [{
    "id": "publish-request",
    "fromActorId": "agent",
    "toActorId": "desktop",
    "label": "Publish checkpoint",
    "style": "call",
    "evidence": { "kind": "anchor", "anchorId": "publish" }
  }]
}
```

Message styles are `call`, `return` or `async`. Every message needs evidence: an anchor or explicitly illustrative `{kind:"illustrative_code",language,text}`. Each message has its own ID even when labels or anchors repeat.

## Call-stack diff

```json
{
  "id": "stack",
  "type": "call_stack_diff",
  "title": "Request path",
  "base": [{ "id": "publish-frame", "anchorId": "publish-base" }],
  "head": [{ "id": "publish-frame", "anchorId": "publish" }]
}
```

Frames have `id,anchorId`, optional `label`, and optional `via:{kind:"call"|"queue"|"callback"|"rpc",reason}`. Array order is the linear flow.

Frame identity is `id`, not the evidence anchor. Base frames use base-side anchors; head frames use head-side anchors, even for a shared frame ID. Shared IDs remain shared even if moved; reordering is not a claim that source was added/deleted. A base-only frame must anchor deleted base lines; a head-only frame must anchor added head lines. Do not put unchanged code on one side just for contrast. The host checks these claims against the pinned diff.

## Database lens

```json
{
  "id": "storage-flow",
  "type": "database_lens",
  "title": "Read review threads",
  "storeIds": ["reviews"],
  "useCases": [{
    "id": "read-threads",
    "label": "Read threads",
    "operations": [{
      "id": "load-threads",
      "kind": "read",
      "store": { "storeId": "reviews", "collectionId": "threads" },
      "actorId": "desktop",
      "label": "Load discussion",
      "anchorId": "publish"
    }]
  }]
}
```

Use-case `summary` and endpoint `fieldId` are optional. Operation `kind` is `read` (store → actor) or `write` (actor → store). Use actual evidence for the operation; the example anchor is only structural. Use-case and operation IDs must be distinct within the node.

## Trace quote, image and software map

```json
{ "id": "intent", "type": "trace_quote", "traceId": "<trace UUID>", "eventId": "<event UUID>", "text": "An exact retained excerpt." }
```

Ingest events through `trace.ingest` first; see [Trace quoting](trace-quoting.md). These are retained client-supplied excerpts, not forkable sessions.

```json
{ "id": "screenshot", "type": "image", "assetId": "<asset UUID>", "alt": "Readable image description", "caption": "Optional caption." }
```

Upload PNG/JPEG/WebP bytes through `asset.upload({reviewId,mimeType,base64})` first. The host decodes and checks the image; use its returned ID. No client filesystem or arbitrary external image URL appears in the node.

```json
{ "id": "architecture", "type": "software_map", "mapVersionId": "<map-version UUID>", "focusElementId": "desktop" }
```

`focusElementId` is optional. Create maps through `map.create/mutate`, then reference the exact returned version. Maps must match the document's pinned repository/commit. The map worker skill describes the model; never write authoritative maps to Git notes.

## Mutation operations

- `{op:"node.insert",node,placement:{parentId,afterId}}`: `parentId:null` means roots; `afterId:null` means first.
- `{op:"node.replace",node}`: same node ID; replace its typed content.
- `{op:"node.move",nodeId,placement}`: preserve identity while moving.
- `{op:"node.remove",nodeId,subtree:boolean}`: removal is explicit.
- `{op:"definition.put",id,value}`
- `{op:"definition.remove",id}`

Validate the proposed final tree, including dependent references. Do not remove a definition while leaving nodes that reference it. Retrieve current limits through `capabilities` rather than assuming an unbounded document.
