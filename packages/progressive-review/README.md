# dev.fast Review

dev.fast Review is an MDX review canvas hosted by Review Desktop. Each review
has a durable UUID directory under
`${DEV_REVIEW_HOME:-~/.dev}/reviews/<uuid>/`. The CLI owns the publish flow
(validation, bundling, sealing); it discovers the desktop server and notifies
it of sealed revisions. The server owns review discovery, session state, and
presentation.

## Review guidance

You can add optional guidance for generated Review documents:

- User-level guidance: `$DEV_REVIEW_HOME/DEV-REVIEW.md`. Review uses
  `~/.dev/DEV-REVIEW.md` by default.
- Repository guidance: `DEV-REVIEW.md` at the source repository root.

Repository guidance takes precedence over user-level guidance.

## Migration

To move legacy Review data with a compatible `review` command, run:

```sh
review migrate apply
```

The command creates verified UUID Reviews. It removes obsolete Review-owned
state. It drops UUID Reviews whose `data.ts` still defines removed `symbol` or
`declarationId` peeks. It preserves range-only Reviews. It reports items that
need an agent. Correct each reported item and run the command again. Use
`--force` to restart interrupted state and drop only code comment threads whose
pinned positions cannot be recovered.

## Usage

Start or activate Review Desktop. You can run this command outside a
repository and without a terminal:

```sh
review app launch --json
```

Run from the repository you want to review:

```sh
review scaffold
```

Edit the reported UUID directory with normal file tools, validate it locally,
then publish:

```sh
cd "${DEV_REVIEW_HOME:-$HOME/.dev}/reviews/<uuid>"
npm test
review publish --review <uuid>
```

`publish` runs the whole gate in the CLI: the software-map check, MDX/TS
compilation and bundling, and resolution of every source range against the
pinned worktree. On success it seals the revision (bundle included)
and notifies the desktop server, which materializes it, mounts it off-screen,
and promotes it only when that mount is clean. A revision that fails either
validation never replaces the visible canvas. Every `review` command accepts
`--json`: stdout then carries only JSON events, one per line, human progress
goes to stderr, and a failure prints a JSON error event too. `publish`, `app`,
and `map publish` print human-readable progress without it. JavaScript belongs
directly in `.mdx`; TypeScript belongs in neighboring `.ts` modules.

To select a published Review, run:

```sh
review app pick
```

Use `review app pick --review <uuid>` to select a specific Review. Bare
`review app` is an alias for `review app launch`. The old
`review app --review <uuid>` form remains an alias for `review app pick`.

`review scaffold` creates one new UUID directory and prints its JSONL `info`
event. `review info` is read-only: it lists active Reviews bound to the current
worktree, or every worktree in the repository with `--all`. Each result has a
`matchesCheckout` field. It is true when the checkout equals or descends from
the Review change.

`review scaffold` materializes the pinned head and base worktrees. It runs each
configured `devfast.prepare` command in those worktrees. This setup gives
Review Desktop language services the dependencies and build output they need.
Source ranges do not need an indexer. `review publish` reads each range from
its pinned worktree and rejects paths or line numbers that are not valid.

Review Desktop is the primary install path for Claude Code, Codex, Cursor, Pi,
and other coding agents. On startup it detects installed agents, offers to
install the CLI and skills, and re-syncs both after each app update. It also
writes a `review` shim to `~/.local/bin` that always resolves to the app's
bundled CLI. `review install` remains for headless environments; a standalone
CLI defers to the app's bundled copy whenever Review Desktop is running.

Agent setup installs only the Review CLI and skills. Enabling Trace capture in
Settings ▸ Experimental Features also installs FFF: it registers the standard
`fff` MCP server for Claude and Codex, and installs `npm:@ff-labs/pi-fff` for
Pi. The MCP registration points FFF at `~/.dev/trace-search`. Review accepts
existing FFF integrations without changes. Silent app-update synchronization
never runs an FFF installer.

The experimental setup configures S3/R2 and enables trace capture for the machine.
Each agent session activates its current repository. Git receives a managed
hook dispatcher that chains the repository's prior hooks. Jujutsu receives a
repository commit-trailer template. A target repository needs no Review files.

Use `review trace status` to inspect the machine and current repository. Use
`review trace enable`, `review trace disable`, or `review trace repair` only
when you need to manage the current repository manually.

For a missing registration, setup runs the equivalent commands:

```sh
curl -fsSL --retry 3 --retry-all-errors https://raw.githubusercontent.com/dmtrKovalenko/fff/main/install-mcp.sh | bash
claude mcp add -s user fff -- "$HOME/.local/bin/fff-mcp" "$HOME/.dev/trace-search"
codex mcp add fff -- "$HOME/.local/bin/fff-mcp" "$HOME/.dev/trace-search"
pi install npm:@ff-labs/pi-fff
```

Trace search uses this local flow:

```text
S3/R2 raw trace
  → temporary download
  → normalized JSONL in ~/.dev/trace-search
  → FFF, review trace show, Review UI, and quote validation
```

The app-managed command starts the exact macOS bundle that installed it. The
bundle does not need to be under `/Applications`. A repository or standalone
CLI uses the `dev.fast.review` macOS bundle identifier.

If `review` opens a browser or reports old options, another command shadows the
current CLI. Run `command -v review`, `review version`, and `review --help`.
Remove the legacy PATH entry, or put the app-managed `~/.local/bin/review`
command first on `PATH`.

The installer copies these bundled skills into the selected agent configs:

- `/dev-review` — author, validate, and publish a Review canvas.
- `/dev-review-map` — generate or refresh the code map.

Other coding agents that follow the shared Agent Skills convention can load the
same skills from `~/.agents/skills`.

Claude Code exposes skill directories as slash commands such as `/dev-review`.
In Codex, invoke the installed Review skills via `/skills` or the skill name. In
Cursor, invoke them from the `/` menu in chat.
