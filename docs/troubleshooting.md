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

`review info`, `review publish`, `review wait`, and map publication need a
healthy Review Desktop server. If launch reports success but those commands
still cannot connect, quit all Review windows, reopen the app, and retry the
launch command.

## No Review appears for the checkout

Run `review info` from the source repository. An empty `reviews` list means the
current worktree has no matching active Review.

Create one with:

```sh
review scaffold
```

For a detached Git checkout, pass `--head <ref>`. For a GitHub pull request,
pass `--pr <number-or-url>`. Use `review info --all` to inspect active Reviews
across every worktree in the repository.

## A Review is out of sync

The bound branch, bookmark, change, or pull request moved after scaffolding.
Re-pin it explicitly:

```sh
review scaffold --update --review <uuid>
```

The authoring agent must reread any changed source ranges, update invalid
anchors, and publish again. Publication warns about stale pins but does not move
them automatically.

## Publish fails

Read the first validation error. A failed publish keeps the last good revision
visible, so it is safe to correct the document and retry.

Common causes include:

- an MDX or TypeScript error in the authored Review;
- a source path or line range that does not exist in the pinned checkout;
- a Review that needs to be updated after its source moved; or
- unresolved submitted feedback that the agent has not addressed.

The scaffolded Review directory contains its own validation command:

```sh
cd "${DEV_REVIEW_HOME:-$HOME/.dev}/reviews/<uuid>"
npm test
review publish --review <uuid>
```

## The Map tab is missing or stale

The document and software map publish independently. A valid Review can open
before its map is ready. Ask the authoring agent to finish the map, or inspect
the current state with:

```sh
review map check --review <uuid>
review map publish --review <uuid>
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
join the [dev.fast Discord](https://discord.gg/FmrJraNvN).
