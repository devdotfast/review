# JSON review API

Desktop and `review server start` share `review-api.db` under `DEV_REVIEW_HOME`.
A headless `--state-dir` or `DEV_REVIEW_SERVER_DIR` selects an isolated profile;
Desktop can view it by using the same directory as `DEV_REVIEW_HOME`.
Both hosts mount the same routes behind token authentication and a bounded JSON request reader.
The canvas and Home read only the native JSON store. `POST /:id/open` opens a review
in Desktop, and pinned tabs reopen after restart. The startup importer migrates
saved MDX reviews before the server starts; there is no legacy runtime or second
catalog. Tests inject the native store and source-data provider.

## Storage and ownership

- `reviews`: current version and one increasing ID counter per review.
- `versions`: complete JSON snapshots, including title, source pins, and content.
- `authoring_drafts`: server-owned scratch state and exclusive review ownership, separate from committed versions.
- `receipts`: command inputs and responses, committed with the saved version.
- `repositories`: server-only local paths; clients receive an ID and display name.
- `resources`: immutable image, trace and software-map bytes, scoped to a repository.
- `review_attention`: viewed/dismissed timestamps, separate from document history.

One host-owned store serializes writes, including asynchronous validation.
An `authoring_sessions` row gives a review one authoring lease across database
connections. While held, content mutations require its `leaseId`; reads and
reader attention remain available. Mutation commits recheck the lease and current
version after asynchronous validation. Independent connections cannot overwrite a
newer version or commit work from an expired session.
Each connection checks SQLite `data_version` every 250 ms and refreshes document,
catalog and activity subscriptions after another connection commits. Desktop is
the sole owner of workspace preparation and cleanup; headless connections never
instantiate that manager. A database-backed process claim prevents a second
Desktop from resetting live workspace generations or running duplicate jobs.
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
| `GET /capabilities` | Desktop availability and permission for optional software-map generation, independent of opening a review |
| `GET /:id/activity` | Currently reported authoring work, not stored in document history |
| `POST /:id/activity {action,leaseId,focus?}` | Begin, renew or end a working signal; return count and expiry |
| `GET /watch` | NDJSON review summaries: initial list, then saved changes |
| `GET /watch?subscriptions=…` | One NDJSON connection for multiple `{reviewId}` subscriptions; `reviewId:null` selects the catalog. Each line is an ordered array of `{value}` or `{error}` results, with `null` where a subscription is unchanged since the previous line. |
| `GET /:id`                                | Compact outline                                                        |
| `GET /:id?targetId=step-3`                | Full block, sequence step, flow node or flow edge                      |
| `GET /:id?full=true`                      | Full snapshot                                                          |
| `GET /:id?version=2&full=true`            | Historical snapshot                                                    |
| `GET /:id/history`                        | Saved versions with titles and timestamps                              |
| `GET /:id/inspect` | Agent reading view: nested text outline with IDs; `targetId` reads one component completely, `full=true` includes all content, `version` selects history. `format=json` returns raw data instead. |
| `POST /:id/open` | Open the review in the attached Desktop; report an error when none is attached |
| `GET /:id/watch`                          | NDJSON snapshots: current state immediately, then committed updates    |
| `POST /commands`                          | Apply one command; return review ID, version, and edited target ID. A `create` with `pullRequestUrl` returns the newest existing review for that PR instead (owner/repository matched case-insensitively) unless `operation.reuseExisting` is `false`: `created:false`, a `note`, its stored `target`, `headMoved`, and `ownedBy`/`otherReviewIds` when they apply; its target is never moved. A new review reports `created:true`. An interactive `create` also opens the new review in an attached Desktop unless `operation.open` is `false`, and reports `opened` with the open result or an `openError`; the review is saved either way |
| `POST /repositories {path}`               | Register a local Git/jj repository; return ID/name                     |
| `POST /pins {repositoryId,base,head}`     | Resolve revisions to immutable commit IDs                              |
| `POST /resources`                         | Upload an image, trace, or map; return resource ID/kind/MIME type      |
| `GET /:id/resources/:resourceId`              | Read retained bytes scoped to the review repository; desktop authentication required                   |
| `GET /:id/maps/:resourceId?version=0` | Read a pinned map with source-change counts for that review version |
| `POST /:id/source {source,version?}`      | Read an exact pinned code range                                        |
| `GET /:id/file?side=head&file=src/app.ts` | Read current target source; version selects authored content; live source always follows the checkout                   |
| `GET /:id/tree?path=src&side=head` | Immediate target directory entries; path defaults to root, side to head; optional version/commit |
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

Commands: `create {title,target,pullRequestUrl?,reuseExisting?}`, `set_target {reviewId,target}`, `edit {reviewId,edit}`, `rename {reviewId,title}`,
`repin {reviewId,pins,pullRequestUrl?}`, `restore {reviewId,version}`. Legacy create with pins remains accepted. Pins contain
`{repositoryId,base,head}` and must identify immutable commits.
Retargeting preserves content and component IDs. Restore restores title, target, PR identity, and content. Live targets still read the current checkout.
PR URLs must be canonical `https://github.com/owner/repository/pull/123` URLs. The PR number is derived from the URL; identity is metadata alongside immutable pins, not a moving source reference, and does not fetch or refresh PR commits. Resolve the intended comparison separately. `repin` preserves the document and component IDs, including when source commits change. Its response reports retained source ranges to verify and resources that no longer match the pins; agents repair these with `edit`. Existing versions keep their original pins and content. Repin preserves omitted PR identity within one repository, clears it when switching repositories, and accepts an explicit URL or null. A `create` that finds its PR's review saves only the command's receipt, so a retry with the same `commandId` replays that answer; `reuseExisting` is part of the saved command.

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
`replace {targetId,content}`. Omitted placement appends to the root; on the
scratchpad it prepends instead, so the pad reads newest first. Diagram
units (a `step` in a sequence, a `flow_node` or `flow_edge` in a flow diagram)
require their diagram as the parent and can move within it, but not between
diagrams; removing a flow node removes the edges that touched it. A new
`flow_node` may carry `link:{from|to,label?,style?}` naming a node already
drawn: the node and its edge are saved in one version, the edge stored as an
ordinary `flow_edge`, and the version's `lastEdit.linkId` names it so the
canvas draws the node in its final place and then the edge. Field patches
preserve omitted values; null removes optional fields. Child collections use
structural edits or replacement. Use fresh content without IDs for insert/replace.

Each accepted edit is one saved version, and the version carries
`lastEdit: {type, targetId, blockId, kind, unit?, linkId?, fields?, units?}`:
the edit's kind, the element it landed on, what that element is, and the block
it belongs to (`unit` names a step, flow node or flow edge inside `blockId`;
`fields` lists an update's patched keys, so a `defaultCollapsed` patch draws nothing;
`units` lists a diagram's steps, or its nodes and edges, in drawing order when
the diagram was inserted or replaced whole, each edge once both of its nodes
are drawn). Versions made by rename, repin, restore or import carry none.
While a reader is watching, the canvas draws each version's edit as it lands:
a paragraph lands, a unit added to a diagram is traced where it attaches, and a
diagram written whole is traced in one quick pass.

There is no expected-version parameter. Later same-field edits win. Reuse the
same command ID and input when retrying a lost response; it will not edit twice.

## Validation and remaining work

Markdown source links use `[label](review-source:head/src/save.ts#L10-L24)`
(or `base`, or `#L10` for one line). Paths are repository-relative and URL-encoded
where needed. Inline and reference-style links open the existing native side peek.
The same Markdown parser feeds the host's source checks and the renderer, so code
examples and unused definitions do not become source requests. Invalid paths or
ranges reject the edit before saving. No extra node type or endpoint is needed.

Heading ids are `slugify(text)` made unique in document order over section
titles and the root-level h2/h3 of Markdown blocks, and `[text](#slug)` links
scroll to them. Markdown images with `https:` sources render inline.

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

The Review tab counts a review as ready once it has content and no authoring
session is live. Ending a lease (or letting it expire) is the only completion
signal; there is no per-section progress state. Versions and share bundles
saved while sections carried a `status` field are read and imported without it;
new edits and draft writes that send one are rejected by the strict section
schema.

Activity uses a caller-chosen lease UUID and no command receipt. Begin acquires
exclusive authoring ownership, renew extends it, and end releases it. Pass
`leaseId` alongside `commandId` on content mutations; each accepted mutation
under the live lease also extends it, inside the same transaction, so a rejected
edit extends nothing. Clients renew only across long reads or pauses; ownership
expires after 3 minutes without an accepted mutation or renewal, which is also
how long a crashed author blocks others and reads as working. Another lease
or an omitted lease gets HTTP 409 while the review is owned. One-off mutations
without a lease remain available while no session owns the review; concurrent
version changes produce a conflict rather than merging.
Repeating begin/end is safe; ending a different lease cannot release the owner.
Leases survive server restart until expiry; deletion removes the lease. Ownership
is not proof of completion. Uploads are immutable repository resources and do not
require a session.
The existing document stream includes an `activity` snapshot and also sends on
activity changes; activity-only sends reuse the loaded document, and the canvas
only loads document data when its version changes.
This avoids another long-lived browser connection. The badge is hidden while
idle or viewing history, and reports unknown activity on a lost connection.
Optional `focus:{description,targetId?}` identifies the current work; description is 1–160 characters and targetId is an existing component ID. Omitted focus retains the lease’s current focus; null clears it. Snapshots include `focuses` when any leases have a focus. The header shows descriptions, and matching components show an inline working indicator. Focus is ephemeral, disappears when its lease ends or expires, and is hidden when activity is unknown or history is displayed.
There is no applying-update state. CLI/MCP expose this as `review_activity`.

Profile migration remains later work.

The focused test file exercises all twelve block kinds, edits and identity,
history/restart, retries, asynchronous validation, isolation, and the actual
desktop HTTP route. The local-data tests use a real Git repository with dirty
working-copy files, decoded images and saved trace/map evidence, including real
HTTP requests and restart. Existing desktop-server tests remain unchanged.

### Language information and committed source

Committed reviews use Review-owned worktrees at their base/head commits for
language services. The displayed source remains the immutable Git source.
Existing matching managed checkouts are reused; an equal base/head shares one
checkout. Opening a review prepares its current sides in the background; older
versions and selected commits acquire environments on demand.

Configure preparation through the repository's existing Git configuration:

```sh
git config devfast.prepare 'pnpm install --frozen-lockfile'
git config --add devfast.prepare 'pnpm generate'
```

Commands run in order inside each managed checkout, never in the invoking user
checkout. Successful preparation is cached by checkout and command-list hash;
changed commands or recreated checkouts invalidate it. Preparation has no canvas
disclosure. `review_open`, and `review_create` when it opens the review, starts acquisition in the background and returns any
already-recorded acquisition issues. `review_environment` rechecks current base/head
checkouts; `retry:true` explicitly reruns failed preparation. Missing setup, pending preparation,
and failed commands with a usable checkout do not produce issues. These checks
report acquisition failures (including transient errors), not end-to-end LSP health.
`review_workspace_cleanup` lists failed cleanup of retired checkouts and accepts
`workspaceId` to retry their removal. Reading and authoring stay available
while preparation runs. Language requests wait for preparation; no command or a
failed command leaves best-effort language services in that same pinned checkout,
without silently borrowing another checkout. Timeout and shutdown stop command
process groups, leave no successful marker, and allow retry.

Language queries require the displayed file to exactly match the file in the
language environment. A changed file suppresses queries even on unchanged lines;
matching contents use the same positions directly. Stale-request checks discard
answers if the source or environment changes during a request.

Definitions, type definitions, implementations, and references stay in the same
review version, side, and selected commit when the destination file matches its
saved source. Preparation may generate or modify files: changed or absent saved
destinations retain their native managed-checkout URIs.

Preparation does not guarantee reproducibility unless the configured commands
also reproduce dependencies, generated files, and the toolchain. Historical
checkouts remain until their owning review is deleted. Environment state and
commands are local and are never authored into review documents.

## Batch authoring

`review server start --authoring-mode batch` selects the batch tool surface explicitly.
`GET /capabilities` reports `authoringMode`; Desktop always uses `interactive`.
`POST /draft-commands/{begin,write,edit,validate,commit,abort}` operates on scratch
state. `GET /drafts/:draftId` returns the document and IDs. Draft source endpoints
(`/drafts/:draftId/{source,file,tree,diff,commits}`) resolve draft pins without an
empty committed placeholder. Resource uploads use the existing repository scope.

Begin claims one review in a short SQLite transaction before reading its current
version. Bulk writes allocate fresh IDs; targeted edits retain existing IDs under
the normal edit rules. Returned IDs are reserved even if an update is aborted.
Normal reads, catalog and history expose committed state only. Interactive
mutations, imports and leases cannot modify a review owned by a batch draft.

Commit validates the entire document, references, pins, sources and resources,
then rechecks owner and starting version in the write transaction. It saves one
snapshot and receipt and clears the draft atomically. Retry the same commit commandId and draftId after a lost response.
Validation errors preserve scratch content for correction. Notifications use the
normal committed-review path.

Ownership belongs to the server instance and PID, with no heartbeat or expiry.
Commit, abort and graceful shutdown release it; a dead PID permits orphan cleanup.
A live owner is never evicted by elapsed time. No draft resume or automatic commit
occurs. CI must terminate its server even if its agent fails.

## Review targets

`target` is either `{kind:"worktree",repositoryId,base?}` or
`{kind:"commits",repositoryId,head,base?}`. Commit revisions resolve on acceptance.
Omitted commit base means source at head with no diff, exactly as base=head;
supply its parent to review the changes introduced by a single commit.

A worktree target follows saved files in that registered checkout, including
staged, unstaged and nonignored untracked files. Without base, Working changes
compares with current HEAD (empty for unborn repositories). No checkout is created.
Source ranges default to the head side. File saves refresh source without changing
authored history. All versions of a live target read the current checkout; authors
maintain their source references. Use a commit target for fixed source.

See [review targets](../../../../docs/cli-reference.md#review-targets) for the supported source and comparison options.
