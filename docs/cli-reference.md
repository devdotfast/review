# CLI reference

<!--
Outline: Common flow -> JSON contract -> Command index -> Lifecycle commands
-> Maps -> Agent installation and migration.
-->

The `review` command is the control surface shared by Review Desktop and coding
agents. Review Desktop installs the preferred CLI in `~/.local/bin` and keeps
it matched to the running app.

Run `review <command> --help` for the authoritative options in your installed
version.

## Compatibility

Review is in beta. Before 1.0, command syntax and JSON event fields may change
between releases. Review Desktop installs an app-managed CLI that matches the
running app; use that copy instead of relying on compatibility between
different CLI and Desktop versions.

The `review map` command group is experimental. Its verbs, Git-notes storage
model, and JSON events may change without a migration period before 1.0.

The `review trace` command group and trace capture are experimental and off
by default. `review install` configures S3/R2 capture only when
`--trace-*` credentials are given; Review Desktop exposes it under Settings ▸
Experimental Features. See [Trace storage](#trace-storage) for the hosted
store and the storage selection commands.

## Common workflow

```sh
review app launch
review info
review api tools
review app pick --review <uuid>
```

Most people let the installed Review skill drive this workflow: it authors
through `review api` or the Review MCP tools. See
`packages/review/skills/dev-review/SKILL.md`.

## Machine-readable output

Commands that expose `--json` accept it after the complete command path:

```sh
review info --json
review app pick --json
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
| `review app`           | Start Review Desktop (background unless `--focus`). Bare `review app` aliases `app launch`. |
| `review app launch`    | Start Review Desktop, or activate a running one with `--focus`.   |
| `review app pick`      | Select a published Review and optionally choose its opened view.  |
| `review info`          | List Reviews associated with the current checkout.                |
| `review api`           | Call a JSON Review authoring tool; `review api tools` lists them. |
| `review mcp`           | Serve the same authoring tools over stdio MCP.                    |
| `review server start`  | Run the foreground authoring server without Desktop.              |
| `review server status` | Check readiness of the selected headless server.                  |
| `review map`           | Author, validate, and share experimental software maps.           |
| `review install`       | Install Review skills for supported coding agents.                |
| `review migrate apply` | Migrate supported legacy Review data.                             |
| `review version`       | Print the Review package version.                                 |

## Headless authoring

`review server start` runs the authoring server in the foreground without a
Desktop installation. `review server status --json` checks readiness. Stop the
server with Ctrl-C or SIGTERM. CLI and MCP clients use the same authoring tools
and shared `dev-review` skill as Desktop.

Set `DEV_REVIEW_SERVER_DIR` for the server and clients to select a job's saved
state, or use `review --state-dir <path> server start` and
`review --state-dir <path> api …`. The default is
`$DEV_REVIEW_HOME` (`~/.dev` by default), shared with Desktop. Optional map generation requires starting with
`--software-maps`; existing map uploads remain supported.

See [headless setup and a GitHub Actions example](https://github.com/devdotfast/review/blob/main/packages/review/skills/dev-review/references/headless-authoring.md).
CI supplies the agent and a prepared checkout with explicit base/head revisions.
Interactive mode (the default) saves each accepted edit as a version. Start with
`--authoring-mode batch` to select scratch drafts and one atomic commit instead.
Capabilities report the selected mode. The `dev-review` skill routes to the short
`dev-review-batch` skill for this workflow. Draft ownership lasts until commit,
abort or server shutdown, without model heartbeats. Uncommitted drafts are
discarded when their server stops.

For local testing, open Desktop on the same `DEV_REVIEW_HOME` and select the
review from Home. Both hosts use `review-api.db`; edits appear live with the same
review ID, history, and resources. The headless server may be stopped after
authoring. For a custom `--state-dir` or `DEV_REVIEW_SERVER_DIR`, launch Desktop
with `DEV_REVIEW_HOME` set to that directory. From this checkout, use `pnpm dev`
to launch the matching Desktop build. `review server open` has been removed.

## Desktop and discovery

```sh
review app launch
review app pick
review app pick --review <uuid> --view diff
review info
review info --all
```

Launches stay in the background; add `--focus` to bring the window forward.
`review app pick` opens an interactive picker when no UUID is given. `review
info` reports titles, UUIDs, status, and whether each
Review is in sync. It requires Review Desktop to be running. `--all` includes
active Reviews for every worktree in the current repository.

The legacy `review app --review <uuid>` form remains a compatibility alias for
`review app pick --review <uuid>`.

`review app pick` accepts `--view` with one of `review`, `commits`, `diff`,
`map`, or `trace`.

## Authoring

Reviews are created and edited through the JSON API: `review api`, the Review
MCP tools, or the installed dev-review skill. See
`packages/review/skills/dev-review/SKILL.md`
and `packages/review/src/review-api/README.md`
for the authoring workflow and the full tool/route list. `review api tools`
prints the current tool catalog.

### Review targets

Register a local checkout with `review_register_repository({path})`, then pass
its `repositoryId` in `target` to `review_create`. Use `review_set_target` to
change an existing review's target while preserving its authored content.
These tools are available through `review api` and MCP.
Live source follows the checkout even in older authored versions; update references
as source changes. Choose a commit target when source must stay fixed.

| Target                                        | Source and comparison                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{kind:"worktree", repositoryId, base?}`      | Saved working files, including staged, unstaged and nonignored untracked files. Compare with `base`, or omit it to review the whole checkout with working changes against current HEAD (an empty baseline in an unborn repository). Unsaved editor buffers are excluded. |
| `{kind:"commits", repositoryId, head, base?}` | Fixed commits. Omit `base` for source at `head` with no diff; supply a base for a comparison.                                                                                                                                                                            |

Revisions resolve when the command is accepted. To review the changes introduced
by one commit, use its parent as `base`; omitting the base is equivalent to
`base=head`. For a GitHub PR, resolve its comparison and pass `pullRequestUrl`
to `review_create`; the URL records identity and does not track new commits.
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

Every map verb accepts `--json`. Run `review map --help` for the storage model
and exact verb syntax.

## Trace storage

```sh
review trace status
review trace storage use s3 [--endpoint <url> --bucket <name> --key <id> --secret <secret> [--region <region>]]
review trace storage use hosted [--origin <url>]
review trace config migrate [--dry-run] [--keep-legacy]
review trace list|show|pull|blame ... [--storage s3|hosted]
review trace sessions [--limit <n>] [--cursor <session-id>] [--storage s3|hosted] [--json]
review login [--traces] [--origin <url>] [--no-browser] [--json]
review logout
review whoami
review trace store create|delete|info [path]
review trace install [--no-harness-hooks] [--all-harnesses] [--json]
review trace uninstall-hooks [--json]
review trace allow [path] [--no-harness-hooks] [--all-harnesses]
review trace deny [path]
```

`review login` signs in with GitHub identity and verified email access. It does
not enable trace collection. `review login --traces` also requests GitHub
repository access. Use `--no-browser` on a remote machine, then open the printed
URL on your desktop. Repository access does not replace per-repository trace
capture consent.

A foreground hosted trace command offers to authorize repositories and resumes
once login succeeds. With `--json`, redirected input, or a hook, it never prompts.
A missing grant produces `repository_authorization_required` and the remedy
`review login --traces`. Local and direct S3 operations do not request GitHub
permissions. `review login` supplies credentials for both sharing and hosted traces.

### Sharing a review

```sh
review share --review <id> [--version <number>] [--request-id <uuid>] [--json]
review share revoke <share-id> [--json]
```

The local Review host must be running. Sharing uploads one immutable saved
version; an omitted version is resolved once when the request starts. The result
contains `shareId`, `version`, and `url`. Running Share again creates a new link unless the same `--request-id` is reused with the same review/version.
Recipients do not need a Review account. They do need Git access to the GitHub
repository. Open the link in Review Desktop, or use **Open Shared Review** in
the command palette. The app downloads the review and fetches its exact base
and head commits into a dedicated managed checkout before opening it.

Pin live worktree reviews to commits before sharing.
Push the reviewed commits to GitHub before sharing. Publication verifies both
commits through a fresh fetch and never pushes them for you. Git uses the
machine's existing credentials. Sharing does not request hosted-trace scopes;
use `review login --traces` only when enabling hosted traces.

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

`review server start` supports publishing without Desktop. The CLI selects the
same server/profile as `review api`, including `--state-dir`. CI can supply
`DEV_REVIEW_SHARE_TOKEN` instead of a saved `review login`; optional
`DEV_REVIEW_SHARE_ORIGIN` selects its bare HTTPS service origin. Environment
credentials are not written to the profile. Git credentials are still needed
for the verification fetch.

Use the [author-and-share action](https://github.com/devdotfast/review/blob/main/actions/author-and-share/README.md) to run
your own agent, upload the committed version, and update one PR comment with
the link. It exposes URL, review ID, version and share ID as outputs.
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
  `review trace allow` and `review trace deny`. Bucket uploads never read it.

An existing bucket setup keeps working unchanged. Without a config file,
`~/.config/dev-trace/env` and `settings.json` (or exported `TRACE_R2_*`
variables) select the bucket exactly as before; no login, migration, or new
configuration is required.

`review trace storage use s3` selects the bucket. With `--endpoint`,
`--bucket`, `--key`, and `--secret` it also saves `stores.s3` after checking
the bucket is reachable. `review trace config migrate` copies an existing
legacy setup into `stores.s3`, refusing to overwrite a different entry or to
switch away from a hosted selection; `--dry-run` previews without writing
and never prints secrets. After a successful migration the legacy `env` and
`settings.json` are renamed to `legacy_env` and `legacy_settings.json` beside
their originals so the new file is the only active source; pass
`--keep-legacy` to leave them in place. To roll back, rename them back and
delete the config file.

`review trace store` manages the hosted store of one repository. `store create`
creates it, one time for each repository, and needs push access. `store info`
reports the store id, the status, and the stored bytes. `store delete` asks the
store to delete the hosted copies, which a repository admin may do; the consent
of this machine stays until `review trace deny` removes it. `review trace
install` installs the harness hooks of this machine and touches no repository.

`review trace uninstall-hooks` removes tracing hooks while keeping the CLI,
login, consent, and captured traces.

`review trace storage use hosted` requires `review login` for the origin,
a store that answers the current contract, and `review trace allow` for the
checkout's repository at that origin; only then does it persist the
selection. Bucket credentials stay saved and inactive. Logging in or
creating a store never selects hosted storage by itself, a legacy bucket always
outranks consent, and a commit trailer alone never authorizes a publication.
Hosted uploads that fail never fall back to the bucket.

Before setup, review [hosted trace consent and access](privacy.md#hosted-trace-store).

Use a Desktop release that supports v2 configuration before migration. `--keep-legacy`
does not prevent older apps from uploading to their saved bucket.

`review version --verbose [--json]` reports CLI paths, delegation, and build
identity. Set `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1` to inspect the invoked CLI directly.

Read commands accept `--storage s3|hosted` to inspect the other store
for one operation. The override never changes the selection, capture
settings, or consent. `review trace status` names the effective store, the
configuration sources in use, and the config file, without revealing
secrets. On a hosted machine it also prints `Stored bytes`, the size of every
completed upload in the repository's store.

`review trace sessions` lists every published session of the current
repository's hosted store, ordered by session id, 50 per page. The command
needs the hosted store. On a machine that selects s3, pass
`--storage hosted`. `--limit` selects a different page size, from 1 to 200.
Each line shows the session id, harness, update time, branch, and stored
bytes. When more sessions follow, the last line names the `--cursor` value of
the next page, and repeats `--limit` when you gave one. The command refuses a
bad `--limit` or `--cursor` before it reads the store.

The command reads the store live. It needs `review login` for the hosted
origin and GitHub read access to the repository. It does not need
`review trace allow`. It never serves saved copies and prints no signed
download URL. The hosted store is the only store it lists, so it refuses
`--storage s3`. Under `--json` the command prints one `trace.sessions` event.
A store older than contract 0.3.0 answers "does not support listing every
session yet"; use `review trace list --commit <sha>` there.

### Desktop and npm installed together

Trace hooks keep the absolute executable of the first working Review
installation. Installing or refreshing the other installation preserves those
harness and repository hooks. If the old executable is missing, setup can
replace it. Without a Desktop launcher, npm tracing resolves `review` from PATH
and records that absolute path.

Desktop preserves an existing npm launcher at `~/.local/bin/review`. Removing
Desktop's trace setup leaves another working installation's hooks and shared
capture settings enabled. `review trace uninstall-hooks` is an explicit reset
of Review hooks in the selected profile, regardless of which installation
created them.

### Tracing without Desktop

The `review trace` commands run without a desktop installation or session.
Install the `@dev.fast/review` npm package with Node 24, then run:

```sh
review login
review trace store create
review trace allow .
review trace status
```

`allow` writes hooks only for harnesses present on the machine. Use
`--all-harnesses` to write all four or `--no-harness-hooks` to write none.
These flags also work with `review trace install`.

## Environment variables

These variables support legacy trace configuration, isolated Desktop launches,
and telemetry administration:

| Variable                                         | Meaning, precedence, and default                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRACE_ENV_FILE`                                 | Selects the legacy direct-bucket environment file. The default is `~/.config/dev-trace/env`. Setting either legacy file variable also makes `review trace setup` update the legacy files unless an S3 profile already exists.  |
| `TRACE_SETTINGS_FILE`                            | Selects the legacy capture settings file. The default is `~/.config/dev-trace/settings.json`. Setting either legacy file variable also makes `review trace setup` update the legacy files unless an S3 profile already exists. |
| `TRACE_HOME_DIR`                                 | Replaces the operating-system home used to find the installed trace command and the trace repository registry under `.config/dev-trace`. The default is the operating-system home.                                             |
| `TRACE_OPENCODE_TRACES_ROOT`                     | Selects where Review writes fresh OpenCode session exports. The default is `$DEV_REVIEW_HOME/opencode-traces`.                                                                                                                 |
| `DEV_FAST_REVIEW_DESKTOP_STATE_ROOT`             | Gives a launched Review Desktop instance separate `user-data` and `extensions` directories beneath this root. Empty or unset uses the normal Desktop state.                                                                    |
| `DEV_FAST_REVIEW_DESKTOP_BACKGROUND` | Set to `1` by `review app` launches without `--focus`. Review Desktop then shows its first window without taking focus and ignores focus requests until you click it or run `review app launch --focus`. |
| `PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL`          | `1` marks telemetry as internal and `0` marks it as external. Either value overrides the stored internal marker and workspace-checkout detection.                                                                              |
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

## Agent integration and migration

```sh
review install [claude|claude-code|codex|cursor|all]
review migrate apply
review migrate apply --force
review version
```

The app normally installs and updates agent skills. Use `review install` for a
headless environment. Migration is only for legacy Review state; use `--force`
only to restart an interrupted migration.
