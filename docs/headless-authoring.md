# Headless authoring design

Status: agreed design, implemented in this change.

## Agreed boundaries

- [CI, authoring, and sharing responsibilities](adr/0001-headless-authoring-boundary.md)
- [Server and storage ownership](adr/0002-headless-authoring-store-ownership.md)

## Intended workflow

1. CI installs the Review npm package and prepares a local checkout with the requested base and head revisions.
2. CI starts `review server start --authoring-mode batch` as a foreground process and checks readiness with `review server status`.
3. CI sets `DEV_REVIEW_SERVER_DIR` to the server state directory (or passes `--state-dir` to each client command). The CI-provided agent authors through `review api` or `review mcp`, following the shared `dev-review` skill.
4. The batch skill validates a scratch draft and commits one snapshot. Interactive mode remains available for immediate committed edits.
5. A later sharing step can consume the saved review through the server. Portable export and upload are separate work.
6. CI stops the server process.

Desktop and headless authoring share `review-api.db` under `DEV_REVIEW_HOME`.
For local testing, open the original review from Desktop Home; content, history,
resources and review IDs are shared, and cross-process changes refresh live.
Desktop alone owns pinned workspace preparation and cleanup. Independent CI jobs
can still select isolated profile directories. Portable sharing remains separate.

## Architecture

- The authoring API accepts an optional desktop-opening callback; the core store and document tools can operate without a UI.
- CLI/MCP clients connect to Desktop by default. Headless connections require explicit state selection and never fall back to Desktop.
- Headless startup owns its foreground lifecycle independently of desktop startup and its app PID.
- Each connection serializes its writes and shares cross-process authoring ownership through SQLite. Short transactions fence commits against concurrent ownership or version changes.
- The store retains review versions and resource bytes. Repository registrations refer to local checkout paths; saving the state directory alone does not make a review portable.
- `review_activity` acquires one exclusive authoring session per review; mutations carry its lease ID and renewal keeps it alive. Ownership expires after 60 seconds without renewal and is checked again when edits commit. Reads remain available. A review with content and no live session reads as ready; there is no other completion state.
- The shared skill calls `review_capabilities` to discover desktop availability and permission for map generation independently of opening a review.
- The traces CLI demonstrates standalone npm installation and JSON output conventions, but has no local server lifecycle to reuse.

## Skill and capabilities

The `dev-review` entry skill routes explicit batch mode to `dev-review-batch`; the interactive instructions remain separate. It discovers server capabilities independently of `review_open`, opens a review when Desktop is available, and proceeds directly when headless. Document and component guidance stays shared. Batch mode uses persistent scratch drafts, no model heartbeats, and one atomic commit; shutdown discards unfinished drafts.

Optional software-map generation is disabled by default for the headless server and enabled explicitly at startup. Capability discovery reports that setting so the skill can decide whether to dispatch a map worker. Uploading existing map resources remains available independently of generation permission.

## Verification targets

- Install and start the packaged runtime on Linux without Desktop or a display session; readiness succeeds and process termination shuts it down cleanly.
- Author and inspect a saved review through both CLI and MCP against prepared base/head commits, retaining the existing source and resource validation.
- Report missing commits with actionable errors and preserve immediate saving for unfinished sections.
- Keep independent job state separate and preserve accepted edits when restarting against the same state and checkout.
- Verify the shared skill's desktop/headless branches and independent map-generation capability discovery.
- Leave portable export, upload, deep links, agent execution, and repository provisioning to their respective owners.

## Author and share in CI

The [author-and-share composite action](https://github.com/devdotfast/review/blob/main/actions/author-and-share/README.md)
composes this runtime with the immutable publisher from PR #338. It accepts a
caller-owned author command and prompt, commits through batch tools, uploads the
exact saved version, and updates a PR comment. CI authentication uses an injected
Review sharing token; agent credentials and setup remain with the harness.
