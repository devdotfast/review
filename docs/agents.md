# Coding agents

<!--
Outline: Built-in setup -> Review instructions -> Change review -> Architecture review
-> Headless install -> Provider boundary.
-->

Review works with Claude Code, Codex, and other coding agents. The desktop app
connects each agent to Review's MCP tools; the running Review server supplies
the authoring instructions.

## Built-in setup

| Agent | Install target | Connection |
| --- | --- | --- |
| Claude Code | `claude` or `claude-code` | MCP entry in `~/.claude.json` |
| Codex | `codex` | MCP entry in `~/.codex/config.toml` |
| Cursor | `cursor` | MCP entry in `~/.cursor/mcp.json` |
| OpenCode | `opencode` | MCP entry in `~/.config/opencode/opencode.json` |
| Pi | `pi` | `dev-review` skill in `~/.agents/skills` |

Review Desktop is the recommended installation path. On first launch it offers
to connect detected agents, and app updates keep them connected. Connect agents
later from **Settings → Agents**. The MCP entry uses Review's bundled runtime;
it needs no `review` command on `PATH`, separate Node installation, port, or
token.

Review replaces an existing Codex `review` entry unless it sets
`enabled = false`. For other agents it leaves customized entries alone.
Uninstall removes only entries Review created. Restart the agent or reconnect
its MCP server after setup.

Review and Review Preview share one entry, which connects to Review when both
are running.

Agents without MCP support get a small `dev-review` skill that uses the
`review` command. Install or remove the command from **Settings → Command
line**.

Each time it starts, Review Desktop removes skills installed by earlier
versions. Skills you wrote are left alone.

## Review instructions

Agents call the `review_get_instructions` tool; from a terminal, run
`review api review_get_instructions '{}'`. The default topic returns the authoring workflow for the
server's mode. Other topics are `headless`, `prepared-worktrees`, `scratchpad`,
and `trace-archaeology`.

In normal use, ask your agent for a Review instead of running the lower-level
CLI commands yourself.

## Start a change review

```text
Use Review to review my current branch against up to date main, then open it
in Review.
```

You can replace “current branch” with a pull request URL or tell the agent which
base and head revisions to compare.

## Start an architecture review

An architecture Review uses the same canvas without requiring a code diff. Ask
for the questions and system boundaries you care about:

```text
Use Review to explain the main data flows, storage boundaries, and critical
code paths in this repository. Open it in Review when it is ready.
```

Specific context produces a better Review. Tell the agent what you already
believe, which risks you care about, and where you want sequence or database
views.

## Install from the terminal

The desktop app is primary, but headless environments can install integrations
explicitly:

```sh
review install codex
review install claude cursor
review install all
```

With no target, `review install` installs every supported integration. It
writes the same entries as Desktop, or none when `DEV_REVIEW_SERVER_DIR` selects
a headless server. Run `review install --help` for the current target list.

## Provider boundary

Review runs locally, but a connected coding agent may send source code, prompts,
and context to its own model provider. Review does not change that provider's
privacy, retention, or billing terms. See [Privacy](privacy.md) for the data
Review itself sends.
