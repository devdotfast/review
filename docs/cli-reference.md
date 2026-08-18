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
| `review app pick` | Select a published Review, interactively or by UUID. |
| `review info` | List Reviews associated with the current checkout. |
| `review scaffold` | Create or update a pinned UUID Review. |
| `review publish` | Validate and publish the Review document. |
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
review app pick --review <uuid>
review info
review info --all
```

`review app pick` opens an interactive picker when no UUID is given. `review
info` reports titles, UUIDs, status, unresolved comments, and whether each
Review is in sync. It requires Review Desktop to be running. `--all` includes
active Reviews for every worktree in the current repository.

The legacy `review app --review <uuid>` form remains a compatibility alias for
`review app pick --review <uuid>`.

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
review publish --review <uuid>
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

Thread commands return JSON. Replies use `Agent` as the author unless
`--author` is provided. Resolve a comment only after its exact request is
addressed. Review owns the SQLite thread store; do not edit it directly.

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
