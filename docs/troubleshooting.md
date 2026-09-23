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
whiteboard app launch --json
```

The app-managed command should resolve through `~/.local/bin/review` and should
offer the commands documented in the [CLI reference](cli-reference.md).

## `review: command not found`

Open Whiteboard Desktop, open the Command Palette, and run **Review: Install CLI in
PATH**. Review refreshes `~/.local/bin/review` and removes the obsolete
`/usr/local/bin/review` symlink if it exists. Then open a new terminal and check
that `~/.local/bin` is on `PATH`.

Agents reach Review through `~/.local/bin/review`. After you install it,
restart any agent that could not start Review's MCP server.

## The command opens a browser or shows old options

Another `review` executable is shadowing the app-managed CLI. Check:

```sh
command -v review
review version
review --help
```

Remove the legacy PATH entry or put `~/.local/bin` before it. A standalone
current CLI defers to the app's bundled copy while Whiteboard Desktop is running so
the client and server stay on the same version.

## Whiteboard Desktop is not running

Start or activate it explicitly:

```sh
whiteboard app launch --json
```

`whiteboard info`, `whiteboard api`, and `whiteboard mcp` need a healthy Whiteboard Desktop
server. If launch reports success but those commands still cannot connect,
quit all Review windows, reopen the app, and retry the launch command.

## The command or MCP talks to the wrong Whiteboard Desktop

Stable, Preview, and dev builds can run at the same time. See which one
commands use:

```sh
whiteboard instances
whiteboard version --verbose
```

The row marked `*` is the one selected. To change it, run
`whiteboard instances use <key>` for the whole machine, or
`export DEV_REVIEW_INSTANCE=<key>` in the shell you start your agent from.
Reconnect the `whiteboard` MCP server afterwards, because an MCP session stays
on the instance it first reached. If the error says the selected instance is
not running, start it (`whiteboard app launch`, or `pnpm dev` in the named
checkout) or pick one of the running instances it lists. For the full
selection order, see the [CLI reference](cli-reference.md#several-whiteboard-desktops-on-one-machine).

## No Review appears for the checkout

Run `whiteboard info` from the source repository. An empty `reviews` list means the
current worktree has no matching active Review.

Ask your coding agent to create one; it registers the repository, resolves
pins, and calls `session_create` (or the equivalent `whiteboard api` command).
Use `whiteboard info --all` to inspect active Reviews across every worktree in the
repository.

## A Review is out of sync

The bound branch, bookmark, change, or pull request moved after the Review was
created. Start a fresh version at updated pins with `session_repin` (or the
equivalent `whiteboard api` command); examine the diff before carrying content
over.

## The Map tab is missing or stale

Ask the authoring agent to finish the map, or inspect the current state with:

```sh
review map check --review <uuid>
```

Run `whiteboard map --help` before editing map scratch state manually.

## A coding agent does not see Review's tools

Copy the prompt for that agent again from **Settings → Agents**, or print it
with `whiteboard connect <agent>`, and paste it into a new session of the agent.
The prompt replaces an existing `review` entry. Then restart the agent or
reload its MCP servers.

Check that `~/.local/bin/review` exists. The prompt runs Review through that
path, because agents started from an app do not see your shell `PATH`.

Codex also needs the Review line in `~/.codex/AGENTS.md`, which its prompt
adds. Pi has no MCP support and uses the `review` skill instead.

See [Coding agents](agents.md#connect-an-agent) for what each prompt sets up.

## Old Review skills are still installed

Earlier versions of Review installed skills into agent configuration. Open
**Settings → Agents** and choose **Remove old Review skills**. It deletes only
skills that Review installed and reports anything it left.

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

Whiteboard Desktop ships its own `diffr` at `bin/diffr` inside its runtime and
uses it unless `REVIEW_DIFFR_BINARY` names another executable. If the
message names a path under the app, the install is damaged; reinstall
Review. In a source checkout, run
`pnpm --filter @dev.fast/review ensure:diffr` to download the pinned
binary. Downloads are explicit so offline and unsupported-host builds still
work. For the npm CLI or an unbundled headless server, install `diffr` on
PATH or set `REVIEW_DIFFR_BINARY` to its executable. A headless server
started from the Desktop installation uses its adjacent bundled binary too.
