# Troubleshooting

<!--
Outline: Baseline checks -> CLI install/version -> Desktop connection -> Discovery
-> Sync -> Publication -> Maps -> Agents -> Updates -> Logs -> Reporting.
-->

Start with these checks:

```sh
command -v review
review version
review --help
review app launch --json
```

The app-managed command should resolve through `~/.local/bin/review` and should
offer the commands documented in the [CLI reference](cli-reference.md).

## `review: command not found`

Open Review Desktop, open the Command Palette, and run **Review: Install CLI in
PATH**. Review refreshes `~/.local/bin/review` and removes the obsolete
`/usr/local/bin/review` symlink if it exists. Then open a new terminal and check
that `~/.local/bin` is on `PATH`.

For a headless setup with a separately installed CLI, run:

```sh
review install all
```

## The command opens a browser or shows old options

Another `review` executable is shadowing the app-managed CLI. Check:

```sh
command -v review
review version
review --help
```

Remove the legacy PATH entry or put `~/.local/bin` before it. A standalone
current CLI defers to the app's bundled copy while Review Desktop is running so
the client and server stay on the same version.

## Review Desktop is not running

Start or activate it explicitly:

```sh
review app launch --json
```

`review info`, `review api`, and `review mcp` need a healthy Review Desktop
server. If launch reports success but those commands still cannot connect,
quit all Review windows, reopen the app, and retry the launch command.

## No Review appears for the checkout

Run `review info` from the source repository. An empty `reviews` list means the
current worktree has no matching active Review.

Ask your coding agent to create one; it registers the repository, resolves
pins, and calls `review_create` (or the equivalent `review api` command).
Use `review info --all` to inspect active Reviews across every worktree in the
repository.

## A Review is out of sync

The bound branch, bookmark, change, or pull request moved after the Review was
created. Start a fresh version at updated pins with `review_repin` (or the
equivalent `review api` command); examine the diff before carrying content
over.

## The Map tab is missing or stale

Ask the authoring agent to finish the map, or inspect the current state with:

```sh
review map check --review <uuid>
```

Run `review map --help` before editing map scratch state manually.

## A coding agent is not detected

Make sure the agent's CLI or app is installed, then reopen Review's welcome
screen. You can install a target explicitly even when automatic detection is
unavailable:

```sh
review install codex
review install claude
review install cursor
```

See [Coding agents](agents.md) for the installed locations and prompts.

## An update failed

Review records a failed update and shows **Update failed** once when the app
reopens on the previous working build. Background checks will not repeatedly
download that same failed build, but a manual retry remains available.

Choose **Review → Check for Updates...** to retry. If the update fails again,
quit Review, [download the latest installer](https://install.dev.fast), and
replace the installed app. Reinstalling the app does not remove Reviews or
settings stored under `~/.dev`.

## Collect app logs

Open the Command Palette and run **Developer: Open Logs Folder**. Review reveals
the current `main.log` in Finder. Reproduce the problem first so the latest
entries capture it.

Logs can contain local paths and extension output. Inspect and redact them
before attaching them to a public issue. For a product defect that needs
diagnostic data, prefer Review's **Report bug** dialog, which sends only the
information and optional attachments shown before submission.

## Report a bug

Use Review's **Report bug** dialog for a product defect. Review shows separate
attachment controls for Review source, map source, and diffs before it sends
anything. Read [Privacy](privacy.md#user-initiated-bug-reports) for the exact
boundary.

For a suspected vulnerability, follow the
[security policy](https://github.com/devdotfast/review/blob/main/SECURITY.md) and
use a private GitHub security advisory. Do not open a public issue with secrets
or exploit details.

Use [GitHub Issues](https://github.com/devdotfast/review/issues) for
reproducible bugs and feature requests. For setup questions and community help,
join the [dev.fast Discord](https://discord.gg/wYvd2cpMQg).

## Structural diffs say diffr cannot be found

Review Desktop ships its own `diffr` at `bin/diffr` inside its runtime and
uses it unless `REVIEW_DIFFR_BINARY` names another executable. If the
message names a path under the app, the install is damaged; reinstall
Review. In a source checkout, run
`pnpm --filter @dev.fast/review ensure:diffr` to download the pinned
binary. Downloads are explicit so offline and unsupported-host builds still
work. For the npm CLI or an unbundled headless server, install `diffr` on
PATH or set `REVIEW_DIFFR_BINARY` to its executable. A headless server
started from the Desktop installation uses its adjacent bundled binary too.
