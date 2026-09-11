# CLI and API reference

These commands describe the JSON-host implementation. Use a CLI and Desktop built from the same version. Desktop must already be running for review operations; the thin clients do not start another server or delegate to another installed CLI.

## Command surface

```sh
review host --help
review host connection
review host capabilities
review host query <operation> --input '<json>'
review host command <operation> --command-id <uuid> --input '<json>'
review host open --review <uuid> [--review-version <number>]
review mcp [--client-id <uuid>]
```

`--input -` reads bounded JSON from stdin. `--client-id <uuid>` is optional on host commands. Commands require a caller-chosen UUID: retry the same operation with the same command ID and identical input after a lost response. Refetch/reconcile version conflicts before sending changed input with a new ID.

Host commands always print JSON; do not add `--json`. Success is `{ok:true,data:{result,eventCursor,commandId?}}`. Failures go to stderr as `{ok:false,error:{code,message,retryable,diagnostics},commandId?}` with a nonzero exit. `host connection` and `host open` have connection/open-specific result data.

Desktop setup utilities such as `review app launch`, `review install` and `review version` remain available. Optional `review trace` utilities are separate from JSON review authoring. Old `scaffold`, `publish`, `threads`, `map`, `wait`, `rebind`, repair and migration commands are not the new review-data API; use the operation families below. Old data is not automatically converted or deleted.

## Minimal authoring flow

Replace placeholders with returned IDs and actual repository refs:

```sh
review host command repository.register --command-id <uuid> --input '{"path":"/absolute/repository/path"}'
review host command review.create --command-id <uuid> --input '{"repositoryId":"<repository UUID>","title":"Explain this change","change":{"kind":"range","baseRef":"<base commit>","headRef":"<head commit>"}}'
review host open --review <review-uuid>
review host query document.get --input '{"reviewId":"<review UUID>"}'
review host command document.mutate --command-id <uuid> --input '{"reviewId":"<review UUID>","expectedReviewVersion":0,"operations":[{"op":"node.insert","node":{"id":"intro","type":"markdown","markdown":"What changed and why."},"placement":{"parentId":null,"position":{"kind":"end"}}}]}'
```

Every accepted material change is saved. Read the returned `reviewVersion` before making another edit:

```sh
review host query review.history --input '{"reviewId":"<review UUID>"}'
review host command review.update --command-id <uuid> --input '{"reviewId":"<review UUID>","expectedReviewVersion":1,"description":"Why this change matters."}'
```

The example versions assume a newly created review with one accepted mutation. Do not reuse those numbers for an existing review. Canvas, metadata, code commits and selected maps share one immutable version; no publish or ready step is required.

## MCP mapping

Configure a stdio MCP entry to run the matching `review` executable with arguments `["mcp"]`. The installer currently installs the CLI/skills, not that MCP entry; use your agent's supported configuration mechanism. Do not invent a URL for an HTTP MCP server.

Tool names map from operations: `review.create → review_create`, `document.mutate → review_document_mutate`, `source.read → review_source_read`. Queries use the operation input directly. Commands add `commandId` at the top level. `review_open({reviewId,reviewVersion?})` selects the live or historical view without restoring it.

MCP tool discovery filters operations by the current credential's capabilities. Object results are returned as structured content; array results are wrapped in `{result:[...]}`. Command receipts and event cursors are available in result metadata. Ask credentials are not author credentials.

## Operation families

The complete strict input/output schemas live in [host-commands.ts](https://github.com/devdotfast/review/blob/main/packages/review-protocol/src/host-commands.ts), [host-source.ts](https://github.com/devdotfast/review/blob/main/packages/review-protocol/src/host-source.ts), [host-resources.ts](https://github.com/devdotfast/review/blob/main/packages/review-protocol/src/host-resources.ts), and [host-feedback.ts](https://github.com/devdotfast/review/blob/main/packages/review-protocol/src/host-feedback.ts). MCP uses those same schemas.

| Area | Commands | Queries |
| --- | --- | --- |
| Setup | `repository.register` | `capabilities`, `repositories.list` |
| Review | `review.create/update/close/reopen/trash/untrash`, `review.revision.create`, `review.version.restore` | `reviews.list`, `review.get/history` |
| Document | `document.mutate/replace` | `document.get/nodes/evidence/validate` |
| Source | — | `source.read/tree/commits/diff` |
| Maps | `map.create/mutate` | `map.get/analyze`, `maps.list` |
| Retained resources | `trace.ingest`, `asset.upload` | `trace.get`, `asset.get` |
| Private drafts | `draft.save/delete` | `drafts.list` |
| Conversations | `thread.create/reply/set_status` | `threads.list`, `thread.get/mapping` |
| Feedback | `feedback.submit` | `feedback.list/get` |
| Ask | `question.start/follow_up/retry/complete` | `questions.list`, `question.get/context` |
| Personal state | `attention.update` | `attention.get` |
| Optional authoring activity | `authoring.begin/renew/end` | `authoring.get` |

Slash-separated names in the table abbreviate separate operations, not CLI subcommands. Availability is permission/capability dependent; human decisions and private drafts are not exposed to an author agent.

Important contracts:

- `review.update({reviewId,expectedReviewVersion,title?,description?,labels?,mapVersions?})` saves a nonempty metadata or map-selection patch. Omitted sides stay selected; `null` clears a side.
- `document.mutate({reviewId,expectedReviewVersion,operations})` supports node insert/update/replace/move/remove and definition put/remove in one transaction.
- `document.validate` accepts the same proposed mutation without committing.
- `source.read({reviewId,reviewVersion,side,file,range?,comparisonCommit?})` returns a whole pinned file, or an inclusive `{fromLine,toLine}` excerpt. `comparisonCommit` selects a review commit versus its first parent.
- `review.revision.create({reviewId,expectedReviewVersion,change})` selects new code and starts a blank canvas with no selected maps. `review.version.restore({reviewId,expectedReviewVersion,fromReviewVersion})` instead copies a complete earlier snapshot into a new version. Both preserve discussions and history.
- `map.create({reviewId,reviewVersion,side,map})` takes file/line locators and returns a host-resolved immutable version. `map.mutate({reviewId,mapId,expectedMapVersion,operations})` saves another version without selecting it. `map.analyze` uses saved map IDs, never a duplicate graph.
- `thread.reply({reviewId,threadId,body,replyToMessageId?})` assigns and appends an immutable message. Thread status and draft edits use `expectedThreadVersion` and `expectedDraftVersion`.
- `feedback.submit({reviewId,reviewVersion,decision,drafts:[{draftId,expectedDraftVersion}],body?})` saves the selected drafts and exact-version decision atomically.
- `question.start({reviewId,target,body,harness?})` saves the question before launching a fresh trusted local assistant. Omitted harness uses the advertised default. `question.complete` is limited to the appropriate answer credential.
- Targets include `reviewVersion` and `kind:"document"|"node"|"source"|"diagram"`, with the corresponding IDs/range. Trace quotations use their node target.

## HTTP and subscriptions

Desktop exposes `GET /v1/connection`, then:

- `POST /v1/workspaces/:workspaceId/commands`
- `POST /v1/workspaces/:workspaceId/queries`
- `GET /v1/workspaces/:workspaceId/events?after=<cursor>&reviewId=<uuid>`
- `POST /v1/app/open` with `{reviewId,reviewVersion?}`
- `POST /v1/workspaces/:workspaceId/reviews/:reviewId/bug-report` with `{reviewVersion,report}`

Use `x-review-token`, never a token in the URL. Command bodies are `{commandId,type,input}`; query bodies are `{type,input}`. Commands additionally send a stable UUID `x-review-client-id` header. API/workspace come from the URL and verified connection, not repeated JSON fields. Failures return `{ok:false,error:{code,message,retryable,diagnostics,currentVersion?}}`.

A query returns an event cursor. Subscribe after that cursor, deduplicate replay, apply each whole `review.committed` event atomically, and refetch on a gap or `review.resync_required`. Historical views keep their saved material while conversations can continue. There is no canvas-report/readiness API. Prefer the typed `ReviewClient` implementation over recreating this protocol.

Support attachments require independent consent for review, maps and diff; optional screenshots are validated JPEGs. The response identifies omitted attachments. An uncertain external upload is not automatically retried.

Discovery uses OS-private `$DEV_REVIEW_HOME/review-desktop/host.json` (default under `~/.dev`). It handles changing local endpoints. Scoped Ask processes use the supplied connection environment and never fall back to an author's discovery token. Do not hand-edit discovery or copy credentials into authored content.
