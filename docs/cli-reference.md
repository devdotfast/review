# CLI reference

<!--
Outline: Common flow -> JSON contract -> Command index -> Lifecycle commands
-> Threads -> Maps -> Agent installation and migration.
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
for coding agents and automation. Thread commands already return JSON.
`review threads list` does not require a `--json` flag.

For example, the installed CLI reports its version as one JSONL event:

```console
$ review version --json
{"event":"version","version":"0.0.1"}
```

## Commands

| Command | Purpose |
| --- | --- |
| `review app` | Start Review Desktop. Bare `review app` aliases `app launch`. |
| `review app launch` | Start or activate Review Desktop. |
| `review app pick` | Select a published Review and optionally choose its opened view. |
| `review info` | List Reviews associated with the current checkout. |
| `review scaffold` | Create or update a pinned UUID Review. |
| `review publish` | Validate and publish the Review document, optionally opening a chosen view. |
| `review rebind` | Move a Review to another branch, bookmark, or change ID. |
| `review wait` | Wait for reviewer activity or an agent-action state. |
| `review threads` | Read, reply to, and resolve Review threads. |
| `review map` | Author, validate, publish, and share experimental software maps. |
| `review install` | Install Review skills for supported coding agents. |
| `review migrate apply` | Migrate supported legacy Review data. |
| `review version` | Print the Review package version. |

## Desktop and discovery

```sh
review app launch
review app pick
review app pick --review <uuid> --view diff
review info
review info --all
```

`review app pick` opens an interactive picker when no UUID is given. `review
info` reports titles, UUIDs, status, unresolved comments, and whether each
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

## Publish, rebind, and wait

```sh
review publish --review <uuid> --view diff
review rebind <branch-bookmark-or-change> --review <uuid>
review wait --review <uuid>
review wait --timeout <seconds> --review <uuid>
review wait --requires-agent --review <uuid>
review wait --requires-agent --codex --review <uuid>
```

`review publish` validates source ranges and the document bundle before it asks
the desktop to present the revision. `review rebind` changes the unit of change
and immediately re-pins the Review.

`review wait` defaults to a 3,600-second timeout. `--requires-agent` returns
when the Review is no longer waiting on the human. `--codex` registers a
detached wait that resumes the current Codex task when reviewer activity
arrives.

## Threads

```sh
review threads list --review <uuid>
review threads get <thread-id> --review <uuid>
review threads reply <thread-id> --body <text> [--author <name>] --review <uuid>
review threads resolve <thread-id> --review <uuid>
```

Thread commands return JSON. Replies are recorded as agent responses and use
`Agent` as the author unless `--author` is provided. After addressing a
submitted comment, reply with a concise disposition and then resolve it. Review
owns the SQLite thread store; do not edit it directly.

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
review trace config migrate [--dry-run]
review trace list|show|pull|blame ... [--storage s3|hosted]
review login [--origin <url>] [--no-browser]
review logout
review whoami
review trace onboard [path]
review trace allow [path] [--no-harness-hooks]
review trace deny [path]
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
    { "repositoryId": 123456789, "name": "owner/repo", "enabledOrigins": ["https://app.dev.fast"], "allowedAt": "…" }
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

Read commands accept `--storage s3|hosted` to inspect the other store
for one operation. The override never changes the selection, capture
settings, or consent. `review trace status` names the effective store, the
configuration sources in use, and the config file, without revealing
secrets.

## Agent integration and migration

```sh
review install [claude|claude-code|codex|cursor|all]
review migrate apply
review migrate apply --force
review version
```

The app normally installs and updates agent skills. Use `review install` for a
headless environment. Migration is only for legacy Review state; use `--force`
only to restart an interrupted migration and accept its documented cleanup of
unrecoverable legacy threads.
