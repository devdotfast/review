# CLI reference

<!--
Outline: Common flow -> JSON contract -> Command index -> Lifecycle commands
-> Threads -> Maps -> Login and hosted traces -> Agent installation and
migration.
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

The `review trace` command group is experimental and off by default. It needs
no local credentials. Run `review login`, then `review trace allow .` in each
repository that may publish traces. Review Desktop exposes the hook installer
under Settings ▸ Experimental Features.

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
| `review login` | Log in to the hosted trace store with GitHub. |
| `review logout` | Forget the hosted trace store login. |
| `review whoami` | Show the hosted trace store login. |
| `review trace` | Manage agent traces in the hosted trace store. |
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

## Login and hosted traces

```sh
review login
review login --no-browser
review whoami
review logout
```

`review login` opens a browser to sign in with GitHub and stores a session
token at `$DEV_REVIEW_HOME/auth.json`. Use `--no-browser` on a headless
machine; the command prints a URL to open elsewhere. `review whoami` shows
the stored login. `review logout` deletes it.

```sh
review trace onboard [path]
review trace allow [path]
review trace allow [path] --no-harness-hooks
review trace deny [path]
review trace status
review trace sync <session-id>
review trace pull
```

`review trace onboard` creates the hosted trace store for the repository
behind the current Git remote. It needs push access on GitHub. Run it once
per repository, before the first `allow`.

`review trace allow` records the repository in
`$DEV_REVIEW_HOME/trace/config.json` and installs the agent harness hooks and
repository Git hooks that capture and sync sessions. Use `--no-harness-hooks`
to skip the agent hook installers. `review trace deny` stops publishing from
the repository and removes the config entry.

`review trace status` shows the login, the allowed repositories, and pending
sessions. `review trace sync <session-id>` uploads a local session's gzipped
trace files through presigned URLs. `review trace pull` downloads the same
way into the local search corpus.

Traces leave the machine only for repositories the user allowed, only to the
store origin, and only while logged in. `trace onboard` and `trace sync`
need `push` access on the repository; `trace pull` needs `pull` access. The
store checks GitHub for the correct access on every call.

`traces` is an alias for `trace`.

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
