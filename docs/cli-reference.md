# CLI and API reference

These commands describe the JSON-host implementation. Use a CLI and Desktop built from the same version. Desktop must already be running for review operations; the thin clients do not start another server or delegate to another installed CLI.

Comments, feedback submission and Ask are unavailable for JSON reviews in this authoring-only version. They are deferred to the third PR in this stack. The command/query registries below describe only the available authoring surface.

## Command surface

```sh
review host --help
review host connection
review host capabilities
review host query <operation> --input '<json>'
review host command <operation> --command-id <uuid> --input '<json>'
review host open --review <uuid>
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
review host command document.mutate --command-id <uuid> --input '{"reviewId":"<review UUID>","expectedDocumentVersion":0,"operations":[{"op":"node.insert","node":{"id":"intro","type":"markdown","markdown":"What changed and why."},"placement":{"parentId":null,"afterId":null}}]}'
```

Use the document and review metadata versions returned by queries when publishing:

```sh
review host command review.publish --command-id <uuid> --input '{"reviewId":"<review UUID>","expectedDocumentVersion":1,"expectedReviewVersion":0,"mapVersions":{"base":null,"head":null}}'
```

The example versions assume a newly created review with one accepted mutation. Do not reuse those numbers for an existing review. Mutation is atomic; publication is explicit and produces an immutable checkpoint.

## MCP mapping

Configure a stdio MCP entry to run the matching `review` executable with arguments `["mcp"]`. The installer currently installs the CLI/skills, not that MCP entry; use your agent's supported configuration mechanism. Do not invent a URL for an HTTP MCP server.

Tool names map from operations: `review.create → review_create`, `document.mutate → review_document_mutate`, `source.read → review_source_read`. Queries use the operation input directly. Commands add `commandId` at the top level. `review_open({reviewId})` only selects the desktop window/tab.

MCP tool discovery filters operations by the current credential's capabilities. Object results are returned as structured content; array results are wrapped in `{result:[...]}`. Command receipts and event cursors are available in result metadata. A read-only credential does not grant author permissions.

## Operation families

The complete strict input/output schemas live in [host-commands.ts](../packages/review-protocol/src/host-commands.ts), [host-source.ts](../packages/review-protocol/src/host-source.ts), and [host-resources.ts](../packages/review-protocol/src/host-resources.ts). MCP uses those same schemas.

| Area | Commands | Queries |
| --- | --- | --- |
| Setup | `repository.register` | `capabilities`, `repositories.list` |
| Review | `review.create/update/close/reopen/trash/restore/attention` | `reviews.list`, `review.get`, `attention.get` |
| Document | `document.mutate/replace/restore` | `document.get/nodes/evidence/history/validate` |
| Checkpoint | `review.publish` | `checkpoints.list`, `checkpoint.get` |
| Pins | `review.repin.plan/apply` | `repin_plan.get` |
| Source | — | `source.read/file/tree/commits/diff` |
| Maps | `map.create/mutate` | `map.get`, `maps.list` |
| Retained resources | `trace.ingest`, `asset.upload` | `trace.get`, `asset.get` |
| Viewer observations | `canvas.report` | `canvas.reports` |

Slash-separated names in the table abbreviate separate operations, not CLI subcommands. Availability is permission/capability dependent; human-only lifecycle actions are not exposed to an author agent.

Important contracts:

- `review.update({reviewId,expectedVersion,title,description,labels})` changes metadata independently of the document.
- `document.mutate({reviewId,expectedDocumentVersion,operations})` supports node insert/replace/move/remove and definition put/remove in one transaction.
- `document.validate` accepts the same proposed mutation without committing.
- `source.read({reviewId,documentVersion,range:{side,file,fromLine,toLine}})` returns retained/verified source; `source.file` takes `side,file` instead of a range.
- `review.repin.plan` proposes mappings; `review.repin.apply` takes `planId,expectedDocumentVersion,operations` for explicit corrections. Changed/ambiguous ranges require author action.
- `map.create({reviewId,documentVersion,side,map})` returns an immutable map version. `map.mutate` takes `mapId,expectedVersion,operations`.

## HTTP and subscriptions

Desktop exposes `GET /v1/connection`, then:

- `POST /v1/workspaces/:workspaceId/commands`
- `POST /v1/workspaces/:workspaceId/queries`
- `GET /v1/workspaces/:workspaceId/events?after=<cursor>&reviewId=<uuid>`

Use `x-review-token`, never a token in the URL. Command/query envelopes contain `apiVersion:1,hostId,workspaceId,clientId,type,input`; commands also contain `commandId`. Host/workspace mismatches are rejected. Window opening uses the separate native adapter.

A document snapshot includes its event cursor. Subscribe after that cursor, deduplicate replay, apply each whole committed patch atomically, and refetch on a gap or `document.resync_required`. Historical views do not subscribe to working-document changes. Prefer the typed `ReviewClient` implementation over recreating this protocol.

Discovery uses OS-private `$DEV_REVIEW_HOME/review-desktop/host.json` (default under `~/.dev`). It handles changing local endpoints. An explicitly supplied connection never falls back to another discovery credential. Do not hand-edit discovery or copy credentials into authored content.
