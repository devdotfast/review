# dev.fast Review

The `@dev.fast/review` package provides the `review` CLI for headless review
authoring, sharing, and agent trace capture. It requires Node 24.
`review server` and `review trace` run without installing or starting Desktop.
Review Desktop displays the review canvas; its server owns review discovery,
session state, and presentation. Legacy reviews
published with the removed MDX toolchain have a durable UUID directory under
`${DEV_REVIEW_HOME:-~/.dev}/reviews/<uuid>/` and are imported into the JSON
store when Home lists them or when they are opened.

## Workspace packages

- `@dev.fast/review`: Node runtime, CLI, authoring tools, and skills. Its
  production dependencies are the external libraries used by the compiled Node
  code; workspace libraries bundled by tsdown are development dependencies.
- `@dev.fast/review-canvas` ([app](app/README.md)): private browser UI, layout
  libraries, and browser tests. It builds separately and is not included in npm.
- `@dev.fast/review-desktop`: installs the Node runtime and copies the built canvas.

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
`--force` to restart interrupted state.

## Usage

Start or activate Review Desktop. You can run this command outside a
repository and without a terminal:

```sh
review app launch --json
```

Reviews are authored through the JSON API: `review api`, the Review MCP
tools, or the dev-review skill. See
[`skills/dev-review/SKILL.md`](skills/dev-review/SKILL.md) for the authoring
workflow.

To select a review, run:

```sh
review app pick
```

Use `review app pick --review <uuid>` to select a specific Review. Bare
`review app` is an alias for `review app launch`. The old
`review app --review <uuid>` form remains an alias for `review app pick`.

`review info` is read-only: it lists active Reviews bound to the current
worktree, or every worktree in the repository with `--all`. Each result has a
`matchesCheckout` field. It is true when the checkout equals or descends from
the Review change.

Review Desktop is the primary install path for Claude Code, Codex, Cursor, Pi,
and other coding agents. On startup it detects installed agents, offers to
install the CLI and skills, and re-syncs both after each app update. It also
writes a `review` shim to `~/.local/bin` that always resolves to the app's
bundled CLI. `review install` remains for headless environments; a standalone
CLI defers to the app's bundled copy whenever Review Desktop is running.

Agent setup installs only the Review CLI and skills. Enabling Trace capture in
Settings ▸ Experimental Features also installs FFF: it registers the standard
`fff` MCP server for Claude and Codex, and installs `npm:@ff-labs/pi-fff` for
Pi. The MCP registration points FFF at `$DEV_REVIEW_HOME/trace-search`
(default `~/.dev/trace-search`). Review accepts existing FFF integrations
without changes. Silent app-update synchronization never runs an FFF
installer.

The experimental setup configures S3/R2 and enables trace capture for the machine.
Traces go to one selected store: a S3/R2 bucket, or the hosted store
selected explicitly with `review trace storage use hosted` after `review
login` and `review trace allow`. The selection, the store settings, and the
hosted consent list live in `$DEV_REVIEW_HOME/trace/config.json`; an existing
`~/.config/dev-trace` setup keeps selecting the bucket without any change.
Each agent session activates its current repository. Git receives a managed
hook dispatcher that chains the repository's prior hooks. Jujutsu receives a
repository commit-trailer template. A target repository needs no Review files.

Trace capture hooks each agent's session lifecycle: Claude Code and Codex
through their hook settings, Pi through a managed extension, and OpenCode
through a managed `~/.config/opencode/plugins/review-trace.ts` plugin. OpenCode
keeps sessions in its own database, so `review trace sync` renders one with
`opencode export` before upload.

Use `review trace status` to inspect the machine, current repository, and your
recent hosted uploads. Use `review trace status --session <id>` for one session.
Repository writers can upload and check their own upload status. Repository
admins can read transcript content. Download links expire after five minutes.
Status reports the store's publication record; it does not repeat object integrity checks.
If the server is unavailable, status reports "not checked".
Use
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
S3/R2 or hosted raw trace
  → temporary download (hosted copies are checksum-verified)
  → normalized JSONL in ~/.dev/trace-search, scoped per store
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

- `/dev-review` — author a Review canvas, including software maps.

Other coding agents that follow the shared Agent Skills convention can load the
same skills from `~/.agents/skills`.

Claude Code exposes skill directories as slash commands such as `/dev-review`.
In Codex, invoke the installed Review skills via `/skills` or the skill name. In
Cursor, invoke them from the `/` menu in chat.
