# `@dev.fast/traces`

`dev-traces` captures agent session transcripts and publishes them to the
hosted dev.fast trace store at `https://app.dev.fast`. It captures Claude Code,
Codex, OpenCode, and pi sessions in the repositories you allow. It is the
capture-only companion of the `review` CLI. It needs no Review Desktop install.

Read what a transcript holds, and who can read it, before you allow a
repository: [hosted trace store](https://github.com/devdotfast/review/blob/main/docs/privacy.md#hosted-trace-store).
A transcript can hold prompts, model output, source code, file paths, URLs, and
email addresses. Only GitHub users with push access to the repository can read
its traces.

`dev-traces` supports macOS and Linux only. It needs Node.js 22 or newer.

## Quick start

```sh
npx @dev.fast/traces login
cd <repo>
npx @dev.fast/traces onboard
npx @dev.fast/traces allow .
dev-traces check
```

1. `login` starts a GitHub device login. Add `--no-browser` on a machine with
   no browser.
2. `onboard` creates the hosted store of one repository. Run it one time for
   each repository. It needs push access to that repository.
3. `allow` records your consent, installs the `dev-traces` command, and writes
   the hooks.
4. `check` prints one line for each precondition. Every line must say `ok`.

Run your next agent session in that repository. Then read the session back:

```sh
dev-traces sessions --limit 1
dev-traces show <session-id>
```

## Install

`allow`, `enable`, and `repair` install the command before they write the
hooks. The install does four steps:

1. It copies the running package to
   `$DEV_REVIEW_HOME/traces/versions/<version>/`. The default home directory is
   `~/.dev`.
2. It points `$DEV_REVIEW_HOME/traces/current` at that copy.
3. It writes the command file `~/.local/bin/dev-traces`.
4. It adds `~/.local/bin` to `PATH` in `~/.zprofile` or `~/.bash_profile`. A
   fish user gets a hint to run `fish_add_path ~/.local/bin`.

Open a new shell after the first install. The harness hooks and the Git hooks
call `~/.local/bin/dev-traces` by absolute path, so a session never depends on
the npx cache. Pass `--no-install` to write the hooks without the install.

`install` does the copy and the command file, and touches no hook. It moves a
command file of the same name that this package did not write to
`~/.local/bin/dev-traces.bak-<timestamp>`, and prints a warning.

The command file picks the runtime in this order:

1. `$DEV_TRACES_NODE`, when it is set and executable.
2. The Node that ran the install.
3. `node` on `PATH`, at version 22 or newer.

Set `TRACE_DISABLE=1` to make the hooks inert without an uninstall.

## Upgrade

```sh
npx @dev.fast/traces@latest allow .
```

The new version is copied beside the installed one, and `traces/current` moves
to it. The install keeps the two previous versions.

## Uninstall

```sh
dev-traces uninstall
```

`uninstall` removes the command file, the installed versions, the `PATH` block
this package wrote, the harness hooks it owns, and the Git hooks it owns. It
keeps the login, the consent, and the captured sessions. Run `dev-traces deny .`
first to withdraw the consent of one repository.

## Commands

| Command | What it does |
| --- | --- |
| `login [--origin <url>] [--no-browser]`, `logout`, `whoami` | Manage the hosted store login |
| `onboard [path]` | Create the hosted store of one repository |
| `allow [path] [--no-harness-hooks] [--no-install]` | Record consent, install, and write the hooks |
| `deny [path] [--delete-store]` | Withdraw consent; `--delete-store` asks the store to delete the hosted copies |
| `enable [path]`, `disable [path]`, `repair [path]` | Manage the Git trace hooks of one repository |
| `install [--force]`, `uninstall` | Manage the `~/.local/bin/dev-traces` install |
| `check` | Check seven preconditions |
| `status [--session <id>] [--limit <n>] [--cursor <cursor>]` | Print the install block, the selected store, and your uploads |
| `sessions [--limit <n>] [--cursor <session-id>]` | List the published sessions of this repository |
| `list --commit <sha>` | List the agent sessions of one commit |
| `show <session-id> [--trace <name>] [--event <index>] [--kind <kind>]` | Survey one trace, or print one event |
| `pull [--commit <sha>] [--session <id>] [--repo <owner/repo>] [--main-only]` | Pull traces into the local FFF search corpus |
| `blame <file> [-L <start,end>] [--history]` | Blame lines to agent sessions |
| `sync <session-id> [--repo <owner/repo>]` | Upload one local session now |

Most commands accept `--json`. Under `--json` stdout carries one JSON event for
each line, and the human report moves to stderr.

## `dev-traces check`

`check` runs seven checks in this order:

1. `runtime`: the Node the command file runs.
2. `install`: the installed version, the command file, and `PATH`.
3. `login`: the login for the selected store.
4. `repository`: the hosted store of this repository.
5. `consent`: the consent, the capture switch, and the selected store.
6. `hooks`: the harness hooks and the Git hooks, with the owner of each one.
7. `activity`: the pending sessions, the newest published session, and the
   sync failures.

Each check prints one line that starts with `ok` or `FAIL`. A failed check
prints a fix command under its line. `check` exits 1 when one check fails.
Under `--json` it prints one `trace.check` event.

## Shared state with the `review` CLI

`dev-traces` and `review` read and write the same files under
`$DEV_REVIEW_HOME`, which defaults to `~/.dev`:

- `auth.json`: the hosted store login.
- `trace/config.json`: the selected store and the repository consent.
- The sync status and the captured sessions.

One machine can run both commands. The owner of a harness hook is the command
that wrote it last. `check` reports the owner of each harness hook and of the
Git hooks. A hook that either command owns passes the check.

These reads work the same in both commands: `sessions`, `list --commit <sha>`,
`show`, `pull --commit|--session`, and `blame`. These options stay in `review`:
`--review <uuid>`, `--storage`, `storage use`, and `config migrate`.

## Privacy

`dev-traces` publishes the same data as `review`, to the same origin, under the
same consent file. Read
[hosted trace store](https://github.com/devdotfast/review/blob/main/docs/privacy.md#hosted-trace-store)
before you allow a repository.

## Release

Bump `version` in `packages/traces/package.json` in the change pull request.
After that pull request merges, use a checkout at `origin/main` on the merge
commit:

```sh
pnpm --filter @dev.fast/traces build && pnpm --filter @dev.fast/traces test
npm pack --dry-run
pnpm --filter @dev.fast/traces publish --access public
git tag traces-v<version> <merge-sha>
git push origin traces-v<version>
```

Run `npm pack --dry-run` in `packages/traces`. The pack must hold `dist/cli.js`,
`dist/program.js`, the chunk files of the build, `dist/build-info.json`,
`README.md`, `LICENSE`, and `package.json`.
