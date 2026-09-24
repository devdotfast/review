# CLI reference

<!--
Outline: Common flow -> JSON contract -> Command index -> Lifecycle commands
-> Maps -> Agent connection and migration.
-->

The `review` command is the control surface shared by Whiteboard Desktop and coding
agents. Whiteboard Desktop installs the preferred CLI in `~/.local/bin` and keeps
it matched to the running app.

Run `whiteboard <command> --help` for the authoritative options in your installed
version.

## Compatibility

Review is in beta. Before 1.0, command syntax and JSON event fields may change
between releases. Whiteboard Desktop installs an app-managed CLI that matches the
running app; use that copy instead of relying on compatibility between
different CLI and Desktop versions.

The `whiteboard map` command group is experimental. Its verbs, Git-notes storage
model, and JSON events may change without a migration period before 1.0.

The `whiteboard trace` command group and trace capture are experimental and off
by default. `whiteboard trace storage use s3` configures S3/R2 capture and
`whiteboard trace install` installs the per-agent hooks; Whiteboard Desktop exposes it
under Settings ▸ Experimental Features. See [Trace storage](#trace-storage)
for the hosted store and the storage selection commands.

## Common workflow

```sh
whiteboard app launch
whiteboard info
whiteboard api tools
whiteboard app pick --review <uuid>
```

Most people let their coding agent drive this workflow: it authors through
`whiteboard api` or the Review MCP tools. See [Coding agents](agents.md).

`whiteboard api` prints a tool's JSON result, except for text replies such as
`session_get` and `session_diff` patches, which print as-is. List arguments are
JSON arrays:

```sh
whiteboard api session_diff '{"sessionId":"<uuid>","format":"patch","paths":["src/app.ts","docs"]}'
```

## Machine-readable output

Commands that expose `--json` accept it after the complete command path:

```sh
whiteboard info --json
whiteboard app pick --json
review map check --json
review version --json
```

Stdout then contains newline-delimited JSON events only. Human progress moves
to stderr, and failures emit a JSON error event. This is the recommended mode
for coding agents and automation.

For example, the installed CLI reports its version as one JSONL event:

```console
$ review version --json
{"event":"version","version":"0.0.1"}
```

## Commands

| Command                | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `whiteboard app`           | Start Whiteboard Desktop (background unless `--focus`). Bare `whiteboard app` aliases `app launch`. |
| `whiteboard app launch`    | Start Whiteboard Desktop, or activate a running one with `--focus`.   |
| `whiteboard app pick`      | Select a published Review and optionally choose its opened view.  |
| `whiteboard info`          | List Reviews associated with the current checkout.                |
| `whiteboard instances`     | List running Whiteboard Desktops and choose the one commands use. |
| `whiteboard api`           | Call a JSON Review authoring tool; `whiteboard api tools` lists them. |
| `whiteboard mcp`           | Serve the same authoring tools over stdio MCP.                    |
| `whiteboard server start`  | Run the foreground authoring server without Desktop.              |
| `whiteboard server status` | Check readiness of the selected headless server.                  |
| `whiteboard map`           | Author, validate, and share experimental software maps.           |
| `whiteboard connect`       | Print the prompt that connects a coding agent to Review.          |
| `whiteboard migrate apply` | Migrate supported legacy Review data.                             |
| `whiteboard version`       | Print the Review package version.                                 |

## Headless authoring

`whiteboard server start` runs the authoring server in the foreground without a
Desktop installation. `whiteboard server status --json` checks readiness. Stop the
server with Ctrl-C or SIGTERM. CLI and MCP clients use the same authoring tools
and instructions as Desktop.

Set `DEV_REVIEW_SERVER_DIR` for the server and clients to select a job's saved
state, or use `whiteboard --state-dir <path> server start` and
`whiteboard --state-dir <path> api …`. The default is
`$DEV_REVIEW_HOME` (`~/.dev` by default), shared with Desktop. Optional map generation requires starting with
`--software-maps`; existing map uploads remain supported.

CI supplies the agent and a prepared checkout with explicit base/head revisions.
Each accepted edit is saved as a version immediately; the author holds a
`session_activity` lease while writing, exactly as with Desktop.

For local testing, open Desktop on the same `DEV_REVIEW_HOME` and select the
review from Home. Both hosts use `review-api.db`; edits appear live with the same
review ID, history, and resources. The headless server may be stopped after
authoring. For a custom `--state-dir` or `DEV_REVIEW_SERVER_DIR`, launch Desktop
with `DEV_REVIEW_HOME` set to that directory. From this checkout, use `pnpm dev`
to launch the matching Desktop build. `whiteboard server open` has been removed.

## Desktop and discovery

```sh
whiteboard app launch
whiteboard app pick
whiteboard app pick --review <uuid> --view diff
whiteboard info
whiteboard info --all
```

Launches stay in the background; add `--focus` to bring the window forward.
`whiteboard app pick` opens an interactive picker when no UUID is given. `review
info` reports titles, UUIDs, status, and whether each
Review is in sync. It requires Whiteboard Desktop to be running. `--all` includes
active Reviews for every worktree in the current repository.

The legacy `whiteboard app --review <uuid>` form remains a compatibility alias for
`whiteboard app pick --review <uuid>`.

`whiteboard app pick` accepts `--view` with one of `review`, `commits`, `diff`,
`map`, or `trace`.

## Several Whiteboard Desktops on one machine

Stable, Preview, and any `pnpm dev` checkout can run at the same time. They
share one `DEV_REVIEW_HOME`, so every instance sees the same Reviews, sign-in,
and trace settings. Each running Desktop records itself under
`$DEV_REVIEW_HOME/review-desktop/instances/<key>.json`. The key is `stable`,
`preview`, or `dev-<checkout>-<hash>` for a source checkout.

All concurrent Desktops must support instance selection. Quit an older Desktop
before starting a newer one on the same home.

Every command that talks to Desktop, including `whiteboard mcp` and
`whiteboard api`, picks one instance in this order:

1. `DEV_REVIEW_INSTANCE=<key>`, for the current shell and anything started
   from it.
2. The machine default that `whiteboard instances use <key>` writes.
3. The only running instance, when exactly one is running.
4. `stable`.

If the selected instance is not running, the command fails and names the
instances that are running. It never switches to a different one.

```sh
whiteboard instances               # key, channel, state, version, url, checkout
whiteboard instances --json
whiteboard instances use preview   # machine default
whiteboard instances clear
export DEV_REVIEW_INSTANCE=dev-review-8b4e5a7fdb4a   # this shell only
```

`whiteboard app launch` starts the selected stable or Preview app. A dev
instance is started with `pnpm dev` in its checkout. An MCP session keeps the
instance key it first reached, across that Desktop's restarts; to move it to
another instance, reconnect the `whiteboard` MCP server. Agents can call
`whiteboard_status` to see which instance they are using. `whiteboard version --verbose` prints the selected key and its record.

## Authoring

Reviews are created and edited through the JSON API: `whiteboard api` or the Review
MCP tools. See `packages/review/src/review-api/README.md` for the authoring
workflow and the full tool/route list. `whiteboard api tools` prints the current
tool catalog.

### Review targets

Register a local checkout with `session_register_repository({path})`, then pass
its `repositoryId` in `target` to `session_create`. Use `session_set_target` to
change an existing review's target while preserving its authored content.
These tools are available through `whiteboard api` and MCP.
Live source follows the checkout even in older authored versions; update references
as source changes. Choose a commit target when source must stay fixed.

| Target                                        | Source and comparison                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{kind:"worktree", repositoryId, base?}`      | Saved working files, including staged, unstaged and nonignored untracked files. Compare with `base`, or omit it to review the whole checkout with working changes against current HEAD (an empty baseline in an unborn repository). Unsaved editor buffers are excluded. |
| `{kind:"commits", repositoryId, head, base?}` | Fixed commits. Omit `base` for source at `head` with no diff; supply a base for a comparison.                                                                                                                                                                            |

Revisions resolve when the command is accepted. To review the changes introduced
by one commit, use its parent as `base`; omitting the base is equivalent to
`base=head`. For a GitHub PR, `session_create({pullRequestUrl})` needs no
target: Review fetches the PR into a registered checkout of its repository
(using `gh`, or the public GitHub API for metadata) and pins GitHub's head and
diff base, titled from the PR. The pins stay fixed; a later create for the same
PR returns the review with `headMoved` when the PR has moved on.
See [live and pinned worktrees](how-review-works.md#live-and-pinned-worktrees)
for how each target runs language services.

## Software maps

```sh
review map open <rev>
review map open <rev> --force
review map check [<rev>] [--review <uuid>]
review map prune
review map push
review map fetch
```

Maps are stored per commit in Git notes under `refs/notes/dev-fast/*`.

- `open` hydrates an editable scratch map for one revision. `--force` discards
  unflushed scratch edits.
- `check` validates the scratch map and saves it to the revision's note.
- `prune` removes unreachable notes and fully flushed scratch buffers.
- `push` and `fetch` share map notes through `origin`.

Every map verb accepts `--json`. Run `whiteboard map --help` for the storage model
and exact verb syntax.

## Trace storage

```sh
whiteboard trace status
whiteboard trace storage use s3 [--endpoint <url> --bucket <name> --key <id> --secret <secret> [--region <region>]]
whiteboard trace storage use hosted [--origin <url>]
whiteboard trace config migrate [--dry-run] [--keep-legacy]
whiteboard trace list|show|pull|blame ... [--storage s3|hosted]
whiteboard trace sessions [--limit <n>] [--cursor <session-id>] [--storage s3|hosted] [--json]
review login [--traces] [--origin <url>] [--no-browser] [--json]
review logout
review whoami
whiteboard trace store create|delete|info [path]
whiteboard trace install [--no-harness-hooks] [--all-harnesses] [--json]
whiteboard trace uninstall-hooks [--json]
whiteboard trace allow [path] [--no-harness-hooks] [--all-harnesses]
whiteboard trace deny [path]
```

`whiteboard login` signs in with GitHub identity and verified email access. It does
not enable trace collection. `whiteboard login --traces` also requests GitHub
repository access. Use `--no-browser` on a remote machine, then open the printed
URL on your desktop. Repository access does not replace per-repository trace
capture consent.

A foreground hosted trace command offers to authorize repositories and resumes
once login succeeds. With `--json`, redirected input, or a hook, it never prompts.
A missing grant produces `repository_authorization_required` and the remedy
`whiteboard login --traces`. Local and direct S3 operations do not request GitHub
permissions. `whiteboard login` supplies credentials for both sharing and hosted traces.

### Sharing a review

```sh
review share --review <id> [--version <number>] [--request-id <uuid>] [--json]
review share revoke <share-id> [--json]
```

The local Review host must be running. Sharing uploads one immutable saved
version; an omitted version is resolved once when the request starts. The result
contains `shareId`, `version`, and `url`. Running Share again creates a new link unless the same `--request-id` is reused with the same review/version.
Recipients do not need a Review account. They do need Git access to the GitHub
repository. Open the link in Whiteboard Desktop, or use **Open Shared Review** in
the command palette. The app downloads the review and fetches its exact base
and head commits into a dedicated managed checkout before opening it.

Pin live worktree reviews to commits before sharing.
Push the reviewed commits to GitHub before sharing. Publication verifies both
commits through a fresh fetch and never pushes them for you. Git uses the
machine's existing credentials. Sharing does not request hosted-trace scopes;
use `whiteboard login --traces` only when enabling hosted traces.

A share includes the saved review, sender attribution, images, retained maps,
and whole retained trace conversations. Code, diffs, and commit lists come
from Git. Anyone with the link can download retained resources, while GitHub
separately controls repository access. Imported reviews are read-only and
remain available offline after the initial fetch. If fetching fails, configure
Git credentials and retry. Missing managed checkouts can be fetched again from
the same link. Deleting a local share removes only its managed checkout.

Revocation stops new downloads. Already-issued object URLs may work for up to
five minutes, and saved copies remain readable. Branch movement and later
edits do not change a published snapshot.

`whiteboard server start` supports publishing without Desktop. The CLI selects the
same server/profile as `whiteboard api`, including `--state-dir`. CI can supply
`DEV_REVIEW_SHARE_TOKEN` instead of a saved `whiteboard login`; optional
`DEV_REVIEW_SHARE_ORIGIN` selects its bare HTTPS service origin. Environment
credentials are not written to the profile. Git credentials are still needed
for the verification fetch.

The exporter, importer and hosted client remain available from
`@dev.fast/review/sharing` for other hosts.

Review stores traces in one selected place per machine: an **s3** store (an
S3-compatible bucket you own, R2 included) or the **hosted** store at
`https://app.dev.fast`. The configuration lives in
`$DEV_REVIEW_HOME/trace/config.json`:

```json
{
  "version": 2,
  "current-store": "s3",
  "stores": {
    "s3": {
      "endpoint": "https://<account>.r2.cloudflarestorage.com",
      "bucket": "review-traces",
      "accessKeyId": "…",
      "secretAccessKey": "…",
      "region": "auto",
      "capture": { "enabled": true, "autoActivateRepositories": true }
    },
    "hosted": { "origin": "https://app.dev.fast" }
  },
  "repositories": [
    {
      "repositoryId": 123456789,
      "name": "owner/repo",
      "enabledOrigins": ["https://app.dev.fast"],
      "allowedAt": "…"
    }
  ]
}
```

- `current-store` names the store that receives uploads and serves reads.
  When absent, an `s3` store (or a legacy bucket setup) selects `s3`; a
  `hosted` store or a non-empty `repositories` list selects `hosted`; with
  both stores present the pointer is required.
- `stores.s3` must be complete or the file is rejected; exported
  `TRACE_R2_*` variables still override individual fields.
- `stores.hosted.origin` defaults to `https://app.dev.fast`, so a hosted-only
  machine needs no `stores` at all.
- `repositories` is hosted-only consent: the repositories you allowed to
  publish complete session transcripts, and the hosted origins each may
  publish to (`enabledOrigins` defaults to `https://app.dev.fast`). Written by
  `whiteboard trace allow` and `whiteboard trace deny`. Bucket uploads never read it.

An existing bucket setup keeps working unchanged. Without a config file,
`~/.config/dev-trace/env` and `settings.json` (or exported `TRACE_R2_*`
variables) select the bucket exactly as before; no login, migration, or new
configuration is required.

`whiteboard trace storage use s3` selects the bucket. With `--endpoint`,
`--bucket`, `--key`, and `--secret` it also saves `stores.s3` after checking
the bucket is reachable. `whiteboard trace config migrate` copies an existing
legacy setup into `stores.s3`, refusing to overwrite a different entry or to
switch away from a hosted selection; `--dry-run` previews without writing
and never prints secrets. After a successful migration the legacy `env` and
`settings.json` are renamed to `legacy_env` and `legacy_settings.json` beside
their originals so the new file is the only active source; pass
`--keep-legacy` to leave them in place. To roll back, rename them back and
delete the config file.

`whiteboard trace store` manages the hosted store of one repository. `store create`
creates it, one time for each repository, and needs push access. `store info`
reports the store id, the status, and the stored bytes. `store delete` asks the
store to delete the hosted copies, which a repository admin may do; the consent
of this machine stays until `whiteboard trace deny` removes it. `whiteboard trace
install` installs the harness hooks of this machine for every detected agent,
or for all of them with `--all-harnesses`, and touches no repository. Claude
Code, Codex, OpenCode, and Pi have hooks; Cursor has none. For a bucket:

```sh
whiteboard trace storage use s3 --endpoint <url> --bucket <name> --key <id> --secret <secret>
whiteboard trace install
```

`whiteboard trace uninstall-hooks` removes tracing hooks while keeping the CLI,
login, consent, and captured traces.

`whiteboard trace storage use hosted` requires `whiteboard login` for the origin,
a store that answers the current contract, and `whiteboard trace allow` for the
checkout's repository at that origin; only then does it persist the
selection. Bucket credentials stay saved and inactive. Logging in or
creating a store never selects hosted storage by itself, a legacy bucket always
outranks consent, and a commit trailer alone never authorizes a publication.
Hosted uploads that fail never fall back to the bucket.

Before setup, review [hosted trace consent and access](privacy.md#hosted-trace-store).

Use a Desktop release that supports v2 configuration before migration. `--keep-legacy`
does not prevent older apps from uploading to their saved bucket.

`whiteboard version --verbose [--json]` reports CLI paths, delegation, and build
identity. Set `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1` to inspect the invoked CLI directly.

Read commands accept `--storage s3|hosted` to inspect the other store
for one operation. The override never changes the selection, capture
settings, or consent. `whiteboard trace status` names the effective store, the
configuration sources in use, and the config file, without revealing
secrets. On a hosted machine it also prints `Stored bytes`, the size of every
completed upload in the repository's store.

`whiteboard trace sessions` lists every published session of the current
repository's hosted store, ordered by session id, 50 per page. The command
needs the hosted store. On a machine that selects s3, pass
`--storage hosted`. `--limit` selects a different page size, from 1 to 200.
Each line shows the session id, harness, update time, branch, and stored
bytes. When more sessions follow, the last line names the `--cursor` value of
the next page, and repeats `--limit` when you gave one. The command refuses a
bad `--limit` or `--cursor` before it reads the store.

The command reads the store live. It needs `whiteboard login` for the hosted
origin and GitHub read access to the repository. It does not need
`whiteboard trace allow`. It never serves saved copies and prints no signed
download URL. The hosted store is the only store it lists, so it refuses
`--storage s3`. Under `--json` the command prints one `trace.sessions` event.
A store older than contract 0.3.0 answers "does not support listing every
session yet"; use `whiteboard trace list --commit <sha>` there.

### Desktop and npm installed together

Trace hooks keep the absolute executable of the first working Review
installation. Installing or refreshing the other installation preserves those
harness and repository hooks. If the old executable is missing, setup can
replace it. Without a Desktop launcher, npm tracing resolves `review` from PATH
and records that absolute path.

Desktop preserves an existing npm launcher at `~/.local/bin/review`. Removing
Desktop's trace setup leaves another working installation's hooks and shared
capture settings enabled. `whiteboard trace uninstall-hooks` is an explicit reset
of Review hooks in the selected profile, regardless of which installation
created them.

### Tracing without Desktop

The `whiteboard trace` commands run without a desktop installation or session.
Install the `@dev.fast/review` npm package with Node 24, then run:

```sh
review login
whiteboard trace store create
whiteboard trace allow .
whiteboard trace status
```

`allow` writes hooks only for harnesses present on the machine. Use
`--all-harnesses` to write all four or `--no-harness-hooks` to write none.
These flags also work with `whiteboard trace install`.

## Environment variables

These variables support legacy trace configuration, isolated Desktop launches,
and telemetry administration:

| Variable                                         | Meaning, precedence, and default                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEV_REVIEW_INSTANCE`                            | Selects which running Whiteboard Desktop commands and MCP sessions use in this shell: `stable`, `preview`, or a `dev-…` key. It overrides the machine default from `whiteboard instances use`. |
| `TRACE_ENV_FILE`                                 | Selects the legacy direct-bucket environment file. The default is `~/.config/dev-trace/env`. Setting either legacy file variable also makes `whiteboard trace setup` update the legacy files unless an S3 profile already exists.  |
| `TRACE_SETTINGS_FILE`                            | Selects the legacy capture settings file. The default is `~/.config/dev-trace/settings.json`. Setting either legacy file variable also makes `whiteboard trace setup` update the legacy files unless an S3 profile already exists. |
| `TRACE_HOME_DIR`                                 | Replaces the operating-system home used to find the installed trace command and the trace repository registry under `.config/dev-trace`. The default is the operating-system home.                                             |
| `TRACE_OPENCODE_TRACES_ROOT`                     | Selects where Review writes fresh OpenCode session exports. The default is `$DEV_REVIEW_HOME/opencode-traces`.                                                                                                                 |
| `DEV_FAST_REVIEW_DESKTOP_STATE_ROOT`             | Gives a launched Whiteboard Desktop instance separate `user-data` and `extensions` directories beneath this root. Empty or unset uses the normal Desktop state.                                                                    |
| `DEV_FAST_REVIEW_DESKTOP_BACKGROUND` | Set to `1` by `whiteboard app` launches without `--focus`. Whiteboard Desktop then shows its first window without taking focus and ignores focus requests until you click it or run `whiteboard app launch --focus`. |
| `PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL`          | `1` marks telemetry as internal and `0` marks it as external. Either value overrides the stored internal marker and workspace-checkout detection.                                                                              |
| `DEV_FAST_REVIEW_TELEMETRY_ENV`                  | `e2e` or `smoke` sets the `environment` property for a test harness. Other values are ignored.                                                                                                                                |
| `DEV_FAST_REVIEW_CHANNEL`                        | Set by Review Desktop for its server: `stable`, `preview`, or `dev`. Preview keeps a separate telemetry identity.                                                                                                              |
| `POSTHOG_KEY`                                    | Legacy PostHog project key alias. The first non-empty value wins in this order: `PROGRESSIVE_REVIEW_POSTHOG_KEY`, `DEV_FAST_POSTHOG_KEY`, `POSTHOG_KEY`, then the embedded key.                                                |
| `POSTHOG_HOST`                                   | Legacy PostHog host alias. The first non-empty value wins in this order: `PROGRESSIVE_REVIEW_POSTHOG_HOST`, `DEV_FAST_POSTHOG_HOST`, then `POSTHOG_HOST`. When none is set, the host defaults to `https://us.i.posthog.com`.   |
| `DO_NOT_TRACK`                                   | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |
| `DNT`                                            | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |
| `PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`          | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |
| `DEV_FAST_TELEMETRY_DISABLED`                    | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |
| `DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED` | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |
| `DEV_FAST_REVIEW_TELEMETRY_DISABLED`             | Disables passive telemetry when set to `1` or `true`.                                                                                                                                                                          |

See [Telemetry and privacy](telemetry.md) for the complete telemetry controls
and data policy.

## Agent connection and migration

```sh
whiteboard connect [<agent>...] [--json]
review migrate apply
review migrate apply --force
review version
```

`whiteboard connect` prints the prompt that connects an agent to Review, the same
text Whiteboard Desktop copies. Paste it into a session of that agent. Agents are
`claude` (or `claude-code`), `codex`, `cursor`, `opencode`, `pi`, and `all`.
With no agent, it prints every prompt under a heading per agent. `--json` emits one
`connect` event whose `prompts` field maps each agent to its prompt. See
[Coding agents](agents.md#connect-an-agent).

Migration is only for legacy Review state; use `--force` only to restart an
interrupted migration.
