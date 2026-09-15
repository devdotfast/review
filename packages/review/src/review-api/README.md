# Small authoring/storage experiment

Desktop startup owns one `review-api.db` under `DEV_REVIEW_HOME`. Its routes use
the existing desktop token authentication and bounded JSON request reader.
The canvas accepts an API-backed content mode using the existing components;
`POST /:id/open` opens it in Desktop without a legacy review session. Home lists
API reviews alongside legacy reviews; API tabs reopen after restart. Existing saved reviews remain
untouched. Tests can inject a store and data provider into the desktop server.

## Storage and ownership

- `reviews`: current version and one increasing ID counter per review.
- `versions`: complete JSON snapshots, including title, source pins, and content.
- `receipts`: command inputs and responses, committed with the saved version.
- `repositories`: server-only local paths; clients receive an ID and display name.
- `resources`: immutable image, trace and software-map bytes, scoped to a repository.
- `feedback_threads`: conversations and saved drafts, separate from document history.
- `feedback_submissions`: the decision and message IDs from an explicit review submission.
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
| `GET /:id`                                | Compact outline                                                        |
| `GET /:id?targetId=step-3`                | Full block or sequence step                                            |
| `GET /:id?full=true`                      | Full snapshot                                                          |
| `GET /:id?version=2&full=true`            | Historical snapshot                                                    |
| `GET /:id/history`                        | Saved versions with titles and timestamps                              |
| `POST /:id/open` | Open the review in the attached Desktop; report an error when none is attached |
| `GET /:id/watch`                          | NDJSON snapshots: current state immediately, then committed updates    |
| `GET /:id/feedback?version?` | Threads, saved drafts, and submitted decisions; optional version maps code locations onto that version's pins |
| `GET /:id/feedback/watch` | Current feedback immediately, then committed changes; independent of document updates |
| `POST /:id/ask {threadId,messageId}` | Start a fresh agent for a posted question; return running/completed |
| `POST /:id/respond {submissionId}` | Answer a saved request-changes submission; use the submit command's returned `targetId`, not its retry ID |
| `GET /:id/runs/:requestId` | Read transient running/completed/failed status; request ID is the posted question ID or saved submission ID |
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
comments and submitted decisions are separate and are not rolled back.

`attention {reviewId,action:"view"|"dismiss"|"restore"}` records viewing or
reversible dismissal without creating a document version. Home summaries include
the repository name, attention timestamps, thread count, and latest decision for
the current version. New document versions do not inherit an earlier approval.
The list stream is separate from document and feedback streams. Dismissal closes
the native tab and can be undone from Home. Dismissed API reviews stay saved;
`delete {reviewId}` permanently removes their versions and feedback. Old command
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

Feedback uses the same command envelope with
`operation: {type:"feedback", reviewId, action}`:

- `save {threadId,messageId,version,target?,body}` explicitly saves a draft.
- `post {threadId,messageId,version,target?,body}` posts a question immediately.
- `reply {threadId,messageId,version,body,by:"user"|"agent"}` adds a posted follow-up.
- `edit-draft {threadId,messageId,body}` and `discard-draft {threadId,messageId?}` affect only unposted messages.
- `resolve {threadId,resolved}` changes thread status.
- `submit {version,decision:"approve"|"request-changes",messageIds}` posts exactly the selected drafts and records the decision in one transaction.

Bodies must contain text. A target is required for a new thread; subsequent
messages keep the original target. Posted messages are immutable. A thread retains its
original version and target; replies record the version they concern. Targets
reuse the current annotation UI's document, text, graph, and code shapes.
Code selections are checked against their pinned source before a thread is
saved. Threads are read from the shared database, not a server projection cache.
Feedback writes do not create document versions or trigger document streams.
The existing comment UI saves drafts and submits decisions through this API.
Posted messages have no edit/delete controls. A monotonically increasing read
revision prevents delayed feedback responses from replacing newer client state;
it is not a write precondition.

Without `version`, feedback reads and the feedback stream return saved anchors.
With `version`, the host maps unchanged code ranges through line shifts and
renames using the existing conservative remapper. Changed/deleted ranges carry
`change_position` (outdated), not a guessed location. Saved targets are never
rewritten. The canvas rereads this projection when its displayed version or
feedback changes, discarding delayed responses for a previous version. Historical
views retain all conversations, not just messages posted at that version.
Native source widgets refresh when pins change, not for prose or feedback edits.
Their source version can be an earlier snapshot with identical pins; new comments
still record the displayed document version. Outdated locations are labelled in
the thread list and conversation, including drafts.

Ask/request-changes reuse the installed agent adapters and native terminal, without
an author transcript or fork. The agent receives the saved question/version and
reads context through the checkout API. Ask is prompted read-only; request changes
may edit the review. The host saves completed answers; batched replies name each
selected thread. Terminal follow-ups are saved in the terminal's associated thread
(the first selected thread for a batch). No partial answers or Stop UI are added.
Repeated starts do not duplicate a saved answer. Failures leave submitted comments
intact; the same endpoint can retry them. Execution status is in memory and is not
restored after restart. These submissions are not a durable background-job system.

Native source/diff comments use the canvas's same API comment store and the
existing native comment widgets. Targets retain source commit, file, side and
range, including rename paths and selected-commit comparisons. Drafts can be
edited or discarded; posted messages and conversations cannot be deleted.
The Review Add Comment shortcut uses the native composer for API source models.

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
including renamed files and absent diff sides. Native opening supplies this
adapter to the API canvas. Inline maps use the same pinned-source API for their
code inspectors, including unchanged mapped ranges. Immutable map resources
change through document edits, so these maps do not expose the old artifact
refresh action. Fullscreen uses the existing canvas-root overlay.
The Map tab uses the retained head/base maps and updates as they arrive. Map
comment targets use saved block/element IDs, so duplicate display titles are
safe. The Trace tab and quote side panels read retained trace resources; imported
labels are preserved without claiming a harness, commit association, or timestamps.

The thin agent clients use `review api <tool-name> '<json>'` (or `-` for stdin)
and `review mcp` (stdio). `review api tools` lists the host's tool schemas.
Both adapters use existing desktop discovery/authentication and the same HTTP
routes as the canvas. Neither imports the store or validates document content.
Command/resource schemas come from the server's existing Zod definitions; the
MCP SDK handles framing. The checkout skill describes this JSON workflow while
preserving the writing guidance. No integration is installed automatically.

Activity uses a caller-chosen lease UUID and no command receipt. Begin/renew
expires after 60 seconds; clients renew at least every 30 seconds and end when
finished. Different agents have independent leases, so one cannot accidentally
end another's signal. Repeating begin/end is safe. Restart clears this ephemeral
state; deletion clears its timers. It is not a write lock or proof of completion.
The existing document stream includes an `activity` snapshot and also sends on
activity changes; the canvas only loads document data when its version changes.
This avoids another long-lived browser connection. The badge is hidden while
idle or viewing history, and reports unknown activity on a lost connection.
There is no applying-update state. CLI/MCP expose this as `review_activity`.

Ask execution remains later work.
Computer use has verified native opening, source previews, comment save/submit,
inline-map fullscreen/source inspection, live base/head map comparison, and
trace quote/full-trace navigation, not every rich-node interaction.

The focused test file exercises all twelve block kinds, edits and identity,
history/restart, retries, asynchronous validation, isolation, and the actual
desktop HTTP route. The local-data tests use a real Git repository with dirty
working-copy files, decoded images and saved trace/map evidence, including real
HTTP requests and restart. Existing desktop-server tests remain unchanged.
