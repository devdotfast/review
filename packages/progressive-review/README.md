# dev.fast Review

Review Desktop runs one local Review Host. Agents author structured JSON through MCP or the `review host` CLI; the desktop canvas reads the same API and applies accepted changes live.

The host owns review metadata, pinned source evidence, document versions, maps and checkpoints in one shared database. Clients never author `review.mdx`, `data.ts`, SQL, Git notes or bundles.

## Start here

- [Quickstart](../../docs/quickstart.md)
- [CLI and API reference](../../docs/cli-reference.md)
- [Coding agents](../../docs/agents.md)
- [Privacy](../../docs/privacy.md)
- [Desktop development](../../apps/review-desktop/README.md)

With the matching Desktop already running:

```sh
review host capabilities
review host query repositories.list --input '{}'
review host query reviews.list --input '{}'
```

Use `review host command <operation> --command-id <uuid> --input '<json>'` to mutate state, and `review host open --review <uuid>` to show it. `review mcp` exposes the same contracts over stdio. It is a thin client of Desktop, not another review server; installing skills does not automatically register it in an agent's MCP configuration.

## Authoring

The `dev-review` skill coordinates authoring. `dev-review-map` creates pinned map versions when useful. User guidance belongs in `$DEV_REVIEW_HOME/DEV-REVIEW.md` (default `~/.dev/DEV-REVIEW.md`); repository-root `DEV-REVIEW.md` takes precedence.

Publish an immutable checkpoint with `review.publish`. The reader can inspect Live or historical checkpoints. Comments, feedback submission and Ask are unavailable for JSON reviews in this authoring-only version. They are deferred to the third PR in this stack.

## Storage and compatibility

New review state is in `$DEV_REVIEW_HOME/review-host.db`. Local author-client discovery is `$DEV_REVIEW_HOME/review-desktop/host.json`. Both default under `~/.dev`; neither is an authoring API. Never copy credentials into documents or prompts.

Old review directories and `review.db` are left untouched and are not migrated by the JSON path. Obsolete review-data commands are refused. The bundled tutorial may retain trusted legacy rendering; it is not an authorable extension mechanism.

Optional trace capture/search, desktop installation, settings and telemetry remain separate features. They are not prerequisites for JSON authoring.
