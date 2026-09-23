# Headless authoring

Install a version of `@dev.fast/review` that includes `review server`, using Node.js 24 and Git. No Review Desktop installation or display session is required. CI owns the agent harness, its model credentials, and checkout preparation.

## Run a server

```sh
npm install --global "@dev.fast/review@$REVIEW_VERSION"
export DEV_REVIEW_HOME="$PWD/.review-state"
export DEV_REVIEW_SERVER_DIR="$DEV_REVIEW_HOME"
review server start --authoring-mode batch --json
```

`start` stays in the foreground. Run the agent from another process, or let CI background the server and terminate it with SIGTERM when finished. `review server status --json` exits successfully only when the selected server is ready. JSON output omits the authentication token; diagnostics go to stderr.

The directory defaults to `$DEV_REVIEW_HOME` (`~/.dev` when no home is configured). Select headless mode explicitly with `DEV_REVIEW_SERVER_DIR` for all processes, or `review --state-dir <path> server start`, `review --state-dir <path> api …`, and `review --state-dir <path> mcp`. `server start` and `server status` also accept a trailing `--state-dir` option. An explicitly selected directory never falls back to Desktop. Without an explicit selection, clients connect only to Desktop and ignore headless discovery files.

The server binds to loopback on an available port. `--port <port>` selects a fixed port. `--software-maps` permits agents to generate optional software maps; uploading existing maps is always supported.

## Configure the agent

The npm installation supplies the CLI. Point the agent at the server with `review api` or a stdio MCP entry (`review mcp` with the same profile environment), and have it read `review_get_instructions({})` first.

Supply the local repository path and explicit base/head revisions. PR discovery, fetching missing commits, and cloning belong to CI. For a PR, also supply its canonical GitHub URL as review metadata. `review_capabilities` reports `authoringMode` independently of Desktop availability. The server selects the batch authoring guidance.

Batch authors begin a scratch draft, investigate source using its `draftId`, write substantial content, validate and commit. Only commit creates a saved version and marks all sections complete. Existing readers see the previous committed version until then; new drafts are absent from Home. On intentional failure, abort the draft. The server retains exclusive ownership without heartbeats until commit, abort or shutdown. CI must stop it during teardown. After a killed server, abandoned scratch content is discarded safely; there is no resume or merge.

Omit `--authoring-mode batch` (or choose `interactive`) to retain immediate committed edits and interactive section progress and renewable activity lease. An agent disconnect does not release a batch draft's lock while its server remains alive.

## Try batch authoring locally

From this repository, in one terminal:

```sh
pnpm review server start --authoring-mode batch
```

Stop an already-running headless server first. In the second terminal, set `export DEV_REVIEW_SERVER_DIR="${DEV_REVIEW_HOME:-$HOME/.dev}"`, then point the agent at the server with `review api` or a stdio MCP entry (`review mcp` with the same profile environment), have it read `review_get_instructions({})` first, and use a prompt such as:

```text
Author a review of /absolute/path/to/checkout,
comparing base <base-sha> with head <head-sha>. The batch server is running.
Use pnpm review api for tools and return the committed review ID and version.
```

For a manual smoke test, with `jq` and a prepared checkout:

```sh
repo=$(pnpm --silent review api review_register_repository \
  "$(jq -n --arg path "$PWD" '{path:$path}')")
pins=$(pnpm --silent review api review_resolve_pins \
  "$(jq -n --arg repositoryId "$(printf '%s' "$repo" | jq -r .id)" \
    --arg base HEAD~1 --arg head HEAD '{repositoryId:$repositoryId,base:$base,head:$head}')")
draft=$(pnpm --silent review api review_draft_begin \
  "$(jq -n --argjson pins "$pins" '{title:"Batch smoke test",pins:$pins}')")
draft_id=$(printf '%s' "$draft" | jq -r .draftId)
pnpm review api review_draft_write \
  "$(jq -n --arg draftId "$draft_id" '{draftId:$draftId,document:[{type:"section",title:"Summary",children:[{type:"markdown",markdown:"A local batch authoring smoke test."}]}]}')"
pnpm review api review_draft_validate "$(jq -n --arg draftId "$draft_id" '{draftId:$draftId}')"
commit_id=$(node -e 'console.log(crypto.randomUUID())')
pnpm review api review_draft_commit \
  "$(jq -n --arg draftId "$draft_id" --arg commandId "$commit_id" '{draftId:$draftId,commandId:$commandId}')"
```

The commit returns the review ID and version `0`. Repeating the same commit input returns that result without adding a version. Open the committed review from Desktop Home on the same profile. Stop the server with Ctrl-C when finished.

## View a local review in Desktop

Desktop must support the current review authoring API. When testing this branch
against an older installed app, run `pnpm dev` from the repository root first to
build and launch the matching Desktop.

Both hosts use `review-api.db` in the same profile. Open Desktop and select the
review from Home: it has the original review ID, full history and retained
resources. New edits appear live; the headless server need not remain running
after authoring finishes. The registered checkout must remain available.

The default profile is shared automatically. For an isolated profile, set
`DEV_REVIEW_HOME` to the same absolute directory in the server, agent and Desktop
processes. If you selected headless state with `--state-dir` or
`DEV_REVIEW_SERVER_DIR`, use that directory as Desktop's `DEV_REVIEW_HOME`.

```sh
# From this repository, launch Desktop on an isolated profile:
DEV_REVIEW_HOME="$PWD/.review-state" pnpm dev
```

The old `review server open` copy command is removed. On first startup, previews'
`reviews.db` or `review-server/reviews.db` are merged into the profile's shared
store while preserving review IDs and history. Stop the old headless server
before upgrading. Original files remain as backups; completed imports are
recorded so deleted reviews are not reimported.

## GitHub Actions example

For an end-to-end workflow that invokes your agent, publishes the review, and
updates a PR comment, use the [author-and-share action](https://github.com/devdotfast/review/tree/main/actions/author-and-share).
The example below is the lower-level authoring-only setup.


Set the repository variable `REVIEW_VERSION` to an exact release containing these commands. Point the agent at the server with `review api` or a stdio MCP entry (`review mcp` with the same profile environment), and have it read `review_get_instructions({})` first. Provide `ci/author-review.sh` invoking your chosen agent; the script receives the checkout path, base SHA, and head SHA as arguments and inherits the server selection. Review does not run or configure the model itself.

```yaml
name: Author a Review
on: pull_request
permissions:
  contents: read
jobs:
  author:
    runs-on: ubuntu-latest
    env:
      REVIEW_VERSION: ${{ vars.REVIEW_VERSION }}
      DEV_REVIEW_HOME: ${{ runner.temp }}/review-state
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      - run: npm install --global "@dev.fast/review@$REVIEW_VERSION"
      - name: Author against the PR commits
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        shell: bash
        run: |
          review server start --authoring-mode batch --json > "$RUNNER_TEMP/review-server.jsonl" &
          server_pid=$!
          trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" || true' EXIT
          for attempt in {1..60}; do
            if review server status --json >/dev/null 2>&1; then break; fi
            kill -0 "$server_pid"
            sleep 1
          done
          review server status --json
          ./ci/author-review.sh "$GITHUB_WORKSPACE" "$BASE_SHA" "$HEAD_SHA"
          # Run any subsequent consumer of the saved review before stopping the server.
```

Each job should select its own directory. A second server cannot own the same directory. Restarting against the same directory preserves committed reviews and resources but discards abandoned drafts, provided the registered checkout paths and commits remain available. The state directory is local working state, not a portable sharing artifact. After authoring, `review share --review <id> --version <version> --json` uploads through the same headless server and returns a link. Supply `DEV_REVIEW_SHARE_TOKEN` to the server for CI authentication, or use a saved `review login`.
