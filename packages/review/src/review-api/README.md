# Small authoring/storage experiment

Desktop startup owns one `review-api.db` under `DEV_REVIEW_HOME`. Its routes use
the existing desktop token authentication and bounded JSON request reader.
The canvas and Home read only the native JSON store. `POST /:id/open` opens a review
in Desktop, and pinned tabs reopen after restart. The startup importer migrates
saved MDX reviews before the server starts; there is no legacy runtime or second
catalog. Tests inject the native store and source-data provider.

## Storage and ownership

- `reviews`: current version and one increasing ID counter per review.
- `versions`: complete JSON snapshots, including title, source pins, and content.
- `receipts`: command inputs and responses, committed with the saved version.
- `repositories`: server-only local paths; clients receive an ID and display name.
- `resources`: immutable image, trace and software-map bytes, scoped to a repository.
- `review_attention`: viewed/dismissed timestamps, separate from document history.

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
| `GET /authoring` | Tool names, host input schemas and HTTP mappings for CLI/MCP adapters |
| `GET /:id/activity` | Currently reported authoring work, not stored in document history |
| `POST /:id/activity {action,leaseId}` | Begin, renew or end a working signal; return count and expiry |
| `GET /watch` | NDJSON review summaries: initial list, then saved changes |
| `GET /watch?subscriptions=…` | One NDJSON connection for multiple `{reviewId}` subscriptions; `reviewId:null` selects the catalog. Each line is an ordered array of `{value}` or `{error}` results, with `null` where a subscription is unchanged since the previous line. |
| `GET /:id`                                | Compact outline                                                        |
| `GET /:id?targetId=step-3`                | Full block or sequence step                                            |
| `GET /:id?full=true`                      | Full snapshot                                                          |
| `GET /:id?version=2&full=true`            | Historical snapshot                                                    |
| `GET /:id/history`                        | Saved versions with titles and timestamps                              |
| `GET /:id/inspect` | Agent reading view: nested text outline with IDs; `targetId` reads one component completely, `full=true` includes all content, `version` selects history. `format=json` returns raw data instead. |
| `POST /:id/open` | Open the review in the attached Desktop; report an error when none is attached |
| `GET /:id/watch`                          | NDJSON snapshots: current state immediately, then committed updates    |
| `POST /commands`                          | Apply one command; return review ID, version, and edited target ID     |
| `POST /repositories {path}`               | Register a local Git/jj repository; return ID/name                     |
| `POST /pins {repositoryId,base,head}`     | Resolve revisions to immutable commit IDs                              |
| `POST /resources`                         | Upload an image, trace, or map; return resource ID/kind/MIME type      |
| `GET /resources/:resourceId`              | Read retained bytes; desktop authentication required                   |
| `GET /:id/maps/:resourceId?version=0` | Read a pinned map with source-change counts for that review version |
| `POST /:id/source {source,version?}`      | Read an exact pinned code range                                        |
| `GET /:id/file?side=head&file=src/app.ts` | Read a complete pinned source file; optional version                   |
| `GET /:id/tree?path=src&side=head` | Immediate committed directory entries; path defaults to root, side to head; optional version/commit |
| `GET /:id/commits?version=0`              | List commits and their first-parent statistics for that review version |
| `GET /:id/diff`                           | Changed-file summaries; optional file for patch text and version       |

Example request:

`review_get` uses `/inspect`. MCP returns its text directly, and
`review api review_get '{"reviewId":"…","full":true}'` prints it without JSON
escaping. Use `format:"json"` (or CLI `--json`) when raw objects are needed.
The canvas continues to use the JSON snapshot routes above.

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

Commands: `create {title,pins,pullRequestUrl?}`, `edit {reviewId,edit}`, `rename {reviewId,title}`,
`repin {reviewId,pins,pullRequestUrl?}`, `restore {reviewId,version}`. Pins contain
`{repositoryId,base,head}` and must identify immutable commits.
Repinning creates a blank snapshot. Restore restores title, pins, PR identity, and content.
PR URLs must be canonical `https://github.com/owner/repository/pull/123` URLs. The PR number is derived from the URL; identity is metadata alongside immutable pins, not a moving source reference, and does not fetch or refresh PR commits. Resolve the intended comparison separately. `repin` preserves the document and component IDs, including when source commits change. Its response reports retained source ranges to verify and resources that no longer match the pins; agents repair these with `edit`. Existing versions keep their original pins and content. Repin preserves omitted PR identity within one repository, clears it when switching repositories, and accepts an explicit URL or null.

`attention {reviewId,action:"view"|"dismiss"|"restore"}` records viewing or
reversible dismissal without creating a document version. Home summaries include
the repository name and attention timestamps.
The list stream is separate from document streams. Dismissal closes
the native tab and can be undone from Home. Dismissed API reviews stay saved;
`delete {reviewId}` permanently removes their versions. Old command
inputs are erased but their IDs remain, so delayed retries cannot resurrect content.
Repository resources remain shared. Home and the canvas open a pinned, read-only
source tree. Each source tab names its review version; files opened from it use
the same version and side through the API, without a client-side checkout path.

Edits: `insert {content,parentId?,afterId?}`, `update {targetId,changes}`,
`move {targetId,parentId?,afterId?}`, `remove {targetId}`,
`replace {targetId,content}`. Omitted placement appends to the root. Steps require
a sequence parent and can move within that diagram. Field patches preserve
omitted values; null removes optional fields. Child collections use structural
edits or replacement. Use fresh content without IDs for insert/replace.

There is no expected-version parameter. Later same-field edits win. Reuse the
same command ID and input when retrying a lost response; it will not edit twice.

## Validation and remaining work

Markdown source links use `[label](review-source:head/src/save.ts#L10-L24)`
(or `base`, or `#L10` for one line). Paths are repository-relative and URL-encoded
where needed. Inline and reference-style links open the existing native side peek.
The same Markdown parser feeds the host's source checks and the renderer, so code
examples and unused definitions do not become source requests. Invalid paths or
ranges reject the edit before saving. No extra node type or endpoint is needed.

Headings carry `slugify(text)` ids, made unique in document order: section
titles and the root-level h2/h3 of a Markdown block. A `[text](#slug)` link
scrolls to that heading, expanding the section holding it when it is collapsed.
Markdown images with `https:` sources render inline; anything else is stored as
an image block.

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
file and range. This is separate from each frame's durable element identity.

File and diff reads also accept `commit` to compare one listed commit against
its first parent. It must belong to the requested review version; an unrelated
commit returns 404. Without it, the comparison is the review's base and head.

Native code-peek and diff widgets can now consume API-backed read-only models,
including renamed files and absent diff sides. Native opening supplies this
adapter to the API canvas. Inline maps use the same pinned-source API for their
code inspectors, including unchanged mapped ranges. Immutable map resources
change through document edits, so these maps do not expose the old artifact
refresh action. Fullscreen uses the existing canvas-root overlay.
The Map tab uses the retained head/base maps and updates as they arrive.
The Trace tab and quote side panels read retained trace resources; imported
labels are preserved without claiming a harness, commit association, or timestamps.

The thin agent clients use `review api <tool-name> '<json>'` (or `-` for stdin)
and `review mcp` (stdio). `review api tools` lists the host's tool schemas.
Both adapters use existing desktop discovery/authentication and the same HTTP
routes as the canvas. Neither imports the store or validates document content.
Command/resource schemas come from the server's existing Zod definitions and
the read routes share their query schemas with the catalog (`read-schemas.ts`);
the MCP SDK handles framing. The checkout skill describes this JSON workflow while
preserving the writing guidance. No integration is installed automatically.

Activity uses a caller-chosen lease UUID and no command receipt. Begin/renew
expires after 60 seconds; clients renew at least every 30 seconds and end when
finished. Different agents have independent leases, so one cannot accidentally
end another's signal. Repeating begin/end is safe. Restart clears this ephemeral
state; deletion clears its timers. It is not a write lock or proof of completion.
The existing document stream includes an `activity` snapshot and also sends on
activity changes; activity-only sends reuse the loaded document, and the canvas
only loads document data when its version changes.
This avoids another long-lived browser connection. The badge is hidden while
idle or viewing history, and reports unknown activity on a lost connection.
There is no applying-update state. CLI/MCP expose this as `review_activity`.

Profile migration remains later work.

The focused test file exercises all twelve block kinds, edits and identity,
history/restart, retries, asynchronous validation, isolation, and the actual
desktop HTTP route. The local-data tests use a real Git repository with dirty
working-copy files, decoded images and saved trace/map evidence, including real
HTTP requests and restart. Existing desktop-server tests remain unchanged.
