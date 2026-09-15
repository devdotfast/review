# Small authoring/storage experiment

Desktop startup owns one `review-api.db` under `DEV_REVIEW_HOME`. Its routes use
the existing desktop token authentication and bounded JSON request reader.
The canvas accepts an API-backed content mode using the existing components;
native desktop opening is not switched over yet. Existing saved reviews remain
untouched. Tests can inject a store and data provider into the desktop server.

## Storage and ownership

- `reviews`: current version and one increasing ID counter per review.
- `versions`: complete JSON snapshots, including title, source pins, and content.
- `receipts`: command inputs and responses, committed with the saved version.
- `repositories`: server-only local paths; clients receive an ID and display name.
- `resources`: immutable image, trace and software-map bytes, scoped to a repository.

One desktop-owned store serializes writes, including asynchronous validation.
Reads see the last committed snapshot. Multiple API callers are supported;
multiple independent store instances writing the same database are not.
The caller closes the store after closing the HTTP server.

The document is a tree of Markdown and self-contained components. The server
adds IDs directly to those objects. No content hashes, manifests, global
definition tables, retired-ID scans, or second authoring representation.
Updates/moves retain IDs; replacement retains the outer ID but creates fresh
child IDs. Restoring an old snapshot does not roll back the ID counter.

## API

All paths below are relative to `/reviews-api`.

| Request                                   | Result                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `GET /`                                   | Current review summaries                                               |
| `GET /:id`                                | Compact outline                                                        |
| `GET /:id?targetId=step-3`                | Full block or sequence step                                            |
| `GET /:id?full=true`                      | Full snapshot                                                          |
| `GET /:id?version=2&full=true`            | Historical snapshot                                                    |
| `GET /:id/history`                        | Saved versions with titles and timestamps                              |
| `GET /:id/watch`                          | NDJSON snapshots: current state immediately, then committed updates    |
| `POST /commands`                          | Apply one command; return review ID, version, and edited target ID     |
| `POST /repositories {path}`               | Register a local Git/jj repository; return ID/name                     |
| `POST /pins {repositoryId,base,head}`     | Resolve revisions to immutable commit IDs                              |
| `POST /resources`                         | Upload an image, trace, or map; return resource ID/kind/MIME type      |
| `GET /resources/:resourceId`              | Read retained bytes; desktop authentication required                   |
| `POST /:id/source {source,version?}`      | Read an exact pinned code range                                        |
| `GET /:id/file?side=head&file=src/app.ts` | Read a complete pinned source file; optional version                   |
| `GET /:id/commits?version=0`              | List commits and their first-parent statistics for that review version |
| `GET /:id/diff`                           | Changed-file summaries; optional file for patch text and version       |

Example request:

```json
{
  "commandId": "8575b264-9ef4-46c9-af3c-8185545aeebd",
  "operation": {
    "type": "edit",
    "reviewId": "<returned by create>",
    "edit": {
      "type": "insert",
      "content": {
        "type": "markdown",
        "markdown": "# Summary\n\nWhat changed."
      }
    }
  }
}
```

Commands: `create {title,pins}`, `edit {reviewId,edit}`, `rename {reviewId,title}`,
`repin {reviewId,pins}`, `restore {reviewId,version}`. Pins contain
`{repositoryId,base,head}` and must identify immutable commits.
Repinning creates a blank snapshot. Restore restores title, pins, and content;
comments are not implemented here and are not implicitly rolled back.

Edits: `insert {content,parentId?,afterId?}`, `update {targetId,changes}`,
`move {targetId,parentId?,afterId?}`, `remove {targetId}`,
`replace {targetId,content}`. Omitted placement appends to the root. Steps require
a sequence parent and can move within that diagram. Field patches preserve
omitted values; null removes optional fields. Child collections use structural
edits or replacement. Use fresh content without IDs for insert/replace.

There is no expected-version parameter. Later same-field edits win. Reuse the
same command ID and input when retrying a lost response; it will not edit twice.

## Validation and remaining work

The component schema checks inputs; field patches are checked after merging
with the target. A small relationship pass checks diagram actors, store fields,
and base/head frame sides. Sources and resource references use required host
providers before a version is saved; unchanged references at unchanged pins
are not checked again. Provider errors must use `ReviewInputError` for messages
safe to show to clients; unexpected provider/storage failures return HTTP 500.

The local provider uses existing Git/jj helpers to read committed objects, not
working-copy files. It checks code ranges and resource ownership before saving.
Images are fully decoded to PNG; traces retain supplied text with an explicit
client-supplied provenance label. Map uploads use the existing nested map format,
with a JSON shape check followed by the existing relationship/coverage validator
and pinned source-range checks. Uploads take `{id,repositoryId,kind,...}` with
`base64` for images, `trace:{label,events:[{id,role,text}]}` for traces, or
`pins,side,model` for maps. Reusing an upload ID requires identical content.

The canvas preserves React identities during updates. The stream coalesces
updates when a reader falls behind; reconnecting starts with the current saved
snapshot. Historical views read a fixed snapshot and do not follow live edits.
Call-stack frames can supply a component-local `key` to align the same frame
across base/head despite moved source ranges. Without a key, matching uses the
file and range. This is separate from each frame's durable comment identity.

File and diff reads also accept `commit` to compare one listed commit against
its first parent. It must belong to the requested review version; an unrelated
commit returns 404. Without it, the comparison is the review's base and head.

Native code-peek and diff widgets can now consume API-backed read-only models,
including renamed files and absent diff sides. Native opening still needs to
supply that adapter to the API canvas; it is not yet an end-to-end desktop path.

Native desktop opening/source-tree integration, MCP/CLI, comments, Ask,
review deletion and profile migration remain later work. The rich-node adapters
still need computer-use verification with real native source editors and maps.

The focused test file exercises all twelve block kinds, edits and identity,
history/restart, retries, asynchronous validation, isolation, and the actual
desktop HTTP route. The local-data tests use a real Git repository with dirty
working-copy files, decoded images and saved trace/map evidence, including real
HTTP requests and restart. Existing desktop-server tests remain unchanged.
