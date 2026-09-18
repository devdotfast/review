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
npx @dev.fast/traces store create
npx @dev.fast/traces allow .
dev-traces check
```

1. `login` starts a GitHub device login. Add `--no-browser` on a machine with
   no browser.
2. `store create` creates the hosted store of one repository. Run it one time
   for each repository. It needs push access to that repository.
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
4. It puts `~/.local/bin` on `PATH` the way rustup and Volta do. It writes
   `$DEV_REVIEW_HOME/traces/env` and `env.fish`, and appends one `source` line
   to the startup files of each shell on the machine:
   - `~/.profile`, created when absent. This is the file `sh` and a bash login
     shell read.
   - The bash files that exist among `~/.bash_profile`, `~/.bash_login`, and
     `~/.bashrc`. The install never creates a bash file: a new
     `~/.bash_profile` makes bash skip `~/.profile` and `~/.bashrc` at login.
   - `${ZDOTDIR:-~}/.zshenv`, created when absent.
   - `~/.config/fish/conf.d/dev-traces.fish`.

The install changes no shell file when `~/.local/bin` is already on `PATH`, or
when `DEV_TRACES_NO_MODIFY_PATH=1` is set. In that case put `~/.local/bin` on
`PATH` yourself, or run `. "$HOME/.dev/traces/env"` in a shell of your choice.

Open a new shell after the first install. The harness hooks and the Git hooks
call `~/.local/bin/dev-traces` by absolute path, so a session never depends on
the npx cache.

Pass `--no-install` to write the hooks without the install. Use it when the
install ran earlier: a CI image that already holds `~/.local/bin/dev-traces`,
or a provisioning step that ran `install` before this command.

`allow` writes a harness hook only for a harness this machine holds a
directory for: `~/.claude`, `~/.codex`, `~/.pi`, or `~/.config/opencode`. One
line names the harnesses it skipped. Pass `--all-harnesses` to write all four,
and `--no-harness-hooks` to write none.

`install` sets up this machine: the copy, the command file, and the harness
hooks of Claude, Codex, OpenCode, and pi. It touches no repository, so no
consent and no Git hook. Pass `--no-harness-hooks` for the command file alone.
The install moves a command file of the same name that this package did not
write to `~/.local/bin/dev-traces.bak-<timestamp>`, and prints a warning.

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

`uninstall` removes the command file, the installed versions, the `PATH` lines
and env files this package wrote, the harness hooks it owns, and the Git hooks
it owns. It never deletes a shell startup file. It
keeps the login, the consent, and the captured sessions. Run `dev-traces deny .`
first to withdraw the consent of one repository.

## Commands

| Command | What it does |
| --- | --- |
| `login [--origin <url>] [--no-browser]`, `logout`, `whoami` | Manage the hosted store login |
| `store create [path]` | Create the hosted store of one repository; needs push access |
| `store info [path]` | Show the hosted store of one repository |
| `store delete [path]` | Delete the hosted store of one repository; admins only |
| `allow [path] [--no-harness-hooks] [--all-harnesses] [--no-install]` | Record consent, install, and write the hooks |
| `deny [path]` | Withdraw the consent of one repository |
| `enable [path]`, `disable [path]`, `repair [path]` | Manage the Git trace hooks of one repository |
| `install [--no-harness-hooks] [--all-harnesses] [--force]` | Install the command file and the harness hooks of this machine |
| `uninstall-hooks` | Release this CLI's agent and registered Git hooks; keep the install and data |
| `uninstall` | Remove the `~/.local/bin/dev-traces` install |
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

Review Desktop's managed `review` command takes precedence, even when the app
is closed. While it owns tracing, standalone commands stop with
"Use `review trace install` instead." Only help, version, `uninstall`, and
`uninstall-hooks` remain available. Neither `--no-install` nor
`--no-harness-hooks` bypasses this check. An app that has never installed its
CLI integration does not reserve tracing.

To switch from Desktop to standalone:

```sh
review trace uninstall-hooks
dev-traces install
# In each repository whose Git hooks you want to enable:
dev-traces enable .
```

To switch back:

```sh
dev-traces uninstall-hooks
review trace install
review trace enable .
```

`uninstall-hooks` removes only that CLI's agent hooks and its Git hooks in
registered repositories (including the current repository). It keeps the
executable, login, capture settings, consent and saved traces. The release is
per OS user, so a Desktop profile or automatic update cannot reclaim tracing.
An explicit `install`, `allow`, `enable`, or `repair` opts that CLI back in;
Desktop also opts back in when trace setup is explicitly enabled in its UI.
Removing hooks does not revoke publication consent; use `deny` for that.

A stale Desktop command still reserves tracing.
Repair the Desktop CLI installation, or use a working Review CLI to run
`review trace uninstall-hooks` before switching. After switching, `check` reports the owner
of each harness hook and of the Git hooks.

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
