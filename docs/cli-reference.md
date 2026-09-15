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
review scaffold
review publish --review <uuid>
review app pick --review <uuid>
```

Most people let the installed Review skill drive this workflow.

## Machine-readable output

Commands that expose `--json` accept it after the complete command path:

```sh
review info --json
review scaffold --json
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

| Command                | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `review app`           | Start Review Desktop. Bare `review app` aliases `app launch`.               |
| `review app launch`    | Start or activate Review Desktop.                                           |
| `review app pick`      | Select a published Review and optionally choose its opened view.            |
| `review info`          | List Reviews associated with the current checkout.                          |
| `review scaffold`      | Create or update a pinned UUID Review.                                      |
| `review publish`       | Validate and publish the Review document, optionally opening a chosen view. |
| `review rebind`        | Move a Review to another branch, bookmark, or change ID.                    |
| `review map`           | Author, validate, publish, and share experimental software maps.            |
| `review install`       | Install Review skills for supported coding agents.                          |
| `review migrate apply` | Migrate supported legacy Review data.                                       |
| `review version`       | Print the Review package version.                                           |

## Desktop and discovery

```sh
review app launch
review app pick
review app pick --review <uuid> --view diff
review info
review info --all
```

`review app pick` opens an interactive picker when no UUID is given. `review
info` reports titles, UUIDs, status, and whether each
Review is in sync. It requires Review Desktop to be running. `--all` includes
active Reviews for every worktree in the current repository.

The legacy `review app --review <uuid>` form remains a compatibility alias for
`review app pick --review <uuid>`.

Both `review app pick` and `review publish` accept `--view` with one of
`review`, `commits`, `diff`, `map`, or `trace`.

## Scaffold and update

```sh
review scaffold
review scaffold --pr <number-or-url>
review scaffold --base <ref> --head <ref>
review scaffold --update
review scaffold --update --review <uuid>
review scaffold --new
```

A bare scaffold uses the current checkout and its trunk fork point. Use
`--head` for a detached Git checkout, `--pr` for a GitHub pull request, and
`--new` when you intentionally want another Review for the same source.

`--update` re-resolves an existing Review from its branch, bookmark, change, or
pull-request binding. It creates a Review when none matches. Publication never
moves the pins automatically.

## Publish and rebind

```sh
review publish --review <uuid> --view diff
review rebind <branch-bookmark-or-change> --review <uuid>
```

`review publish` validates source ranges and the document bundle before it asks
the desktop to present the revision. `review rebind` changes the unit of change
and immediately re-pins the Review.

## Software maps

```sh
review map open <rev>
review map open <rev> --force
review map check [<rev>] [--review <uuid>]
review map publish [--review <uuid>]
review map prune
review map push
review map fetch
```

Maps are stored per commit in Git notes under `refs/notes/dev-fast/*`.

- `open` hydrates an editable scratch map for one revision. `--force` discards
  unflushed scratch edits.
- `check` validates the scratch map and saves it to the revision's note.
- `publish` presents the saved base and head maps for a published Review.
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
review login [--origin <url>] [--no-browser]
review logout
review whoami
review trace onboard [path]
review trace allow [path] [--no-harness-hooks]
review trace deny [path] [--delete-store]
```

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
      "bucket": "dev-traces",
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

`review trace storage use hosted` requires `review login` for the origin,
a store that answers the current contract, and `review trace allow` for the
checkout's repository at that origin; only then does it persist the
selection. Bucket credentials stay saved and inactive. Logging in or
onboarding never selects hosted storage by itself, a legacy bucket always
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

### Standalone `dev-traces` command

`npx @dev.fast/traces allow .` installs `dev-traces`, a capture-only CLI for a
machine without Review Desktop. The quick start is `npx @dev.fast/traces login`,
then `npx @dev.fast/traces onboard` in the repository, then
`npx @dev.fast/traces allow .`, then `dev-traces check`. `allow` copies the
package to `$DEV_REVIEW_HOME/traces/` and installs `~/.local/bin/dev-traces`,
which the hooks call by absolute path.

`dev-traces` offers `login`, `logout`, `whoami`, `onboard`, `allow`, `deny`,
`enable`, `disable`, `repair`, `status`, `sessions`, `sync`, and the
repository-scoped reads `list --commit`, `show`, `pull`, and `blame`. The
option names and the `--json` events match the `review trace` forms. Its own
`check` command reports the runtime, the install, the login, the repository
store, the consent, the hooks, and the recent activity on one line each, and
exits 1 when one check fails. `--review <uuid>`, `--storage`, `storage use`,
and `config migrate` stay in `review`. Both commands read and write the same
login, consent, and captured sessions under `$DEV_REVIEW_HOME`. See
`packages/traces/README.md`.

## Environment variables

These variables support legacy trace configuration, isolated Desktop launches,
and telemetry administration:

| Variable | Meaning, precedence, and default |
| --- | --- |
| `TRACE_ENV_FILE` | Selects the legacy direct-bucket environment file. The default is `~/.config/dev-trace/env`. Setting either legacy file variable also makes `review trace setup` update the legacy files unless an S3 profile already exists. |
| `TRACE_SETTINGS_FILE` | Selects the legacy capture settings file. The default is `~/.config/dev-trace/settings.json`. Setting either legacy file variable also makes `review trace setup` update the legacy files unless an S3 profile already exists. |
| `TRACE_HOME_DIR` | Replaces the operating-system home used to find the installed trace command and the trace repository registry under `.config/dev-trace`. The default is the operating-system home. |
| `TRACE_OPENCODE_TRACES_ROOT` | Selects where Review writes fresh OpenCode session exports. The default is `$DEV_REVIEW_HOME/opencode-traces`. |
| `DEV_FAST_REVIEW_DESKTOP_STATE_ROOT` | Gives a launched Review Desktop instance separate `user-data` and `extensions` directories beneath this root. Empty or unset uses the normal Desktop state. |
| `PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL` | `1` marks telemetry as internal and `0` marks it as external. Either value overrides the stored internal marker and workspace-checkout detection. |
| `POSTHOG_KEY` | Legacy PostHog project key alias. The first non-empty value wins in this order: `PROGRESSIVE_REVIEW_POSTHOG_KEY`, `DEV_FAST_POSTHOG_KEY`, `POSTHOG_KEY`, then the embedded key. |
| `POSTHOG_HOST` | Legacy PostHog host alias. The first non-empty value wins in this order: `PROGRESSIVE_REVIEW_POSTHOG_HOST`, `DEV_FAST_POSTHOG_HOST`, then `POSTHOG_HOST`. When none is set, the host defaults to `https://us.i.posthog.com`. |
| `DO_NOT_TRACK` | Disables passive telemetry when set to `1` or `true`. |
| `DNT` | Disables passive telemetry when set to `1` or `true`. |
| `PROGRESSIVE_REVIEW_TELEMETRY_DISABLED` | Disables passive telemetry when set to `1` or `true`. |
| `DEV_FAST_TELEMETRY_DISABLED` | Disables passive telemetry when set to `1` or `true`. |
| `DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED` | Disables passive telemetry when set to `1` or `true`. |
| `DEV_FAST_REVIEW_TELEMETRY_DISABLED` | Disables passive telemetry when set to `1` or `true`. |

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
