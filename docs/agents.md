# Coding agents

<!--
Outline: Built-in setup -> Review instructions -> Change review -> Architecture review
-> Headless install -> Provider boundary.
-->

Review works with Claude Code, Codex, and other coding agents. The desktop app
connects each agent to a Review MCP server, and the running Review server tells
the agent how to create, author, validate, and update a Review through the
Review API and MCP tools.

## Built-in setup

Review Desktop provides setup shortcuts for these agents:

| Agent | Install target | Connection |
| --- | --- | --- |
| Claude Code | `claude` or `claude-code` | Review MCP server in `~/.claude.json` |
| Codex | `codex` | Review MCP server in `~/.codex/config.toml` |
| Cursor | `cursor` | Review MCP server in `~/.cursor/mcp.json` |
| OpenCode | `opencode` | Review MCP server in `~/.config/opencode/opencode.json` |
| Pi | `pi` | `dev-review` pointer skill in `~/.agents/skills` |

Review Desktop is the recommended installation path. On first launch it detects
installed agents and offers to connect them to the Review MCP server; after that,
app updates keep those connections current. You can connect an agent later with
its **Connect** button in **Settings → Agents**.
The MCP entry runs a small launcher in Desktop's state directory using Review's
bundled runtime, so it does not need the `review` command on `PATH`. No separate
Node installation, agent CLI, port, or token configuration is needed. The
desktop server remains the owner of every review.

App updates refresh the launcher and repair missing MCP entries. Review leaves
customized MCP entries alone and explains how to replace them if desired;
uninstall removes only unchanged entries it created. Restart the agent or
reconnect its MCP server after setup.

Pi has no MCP connection. It gets a small `dev-review` pointer skill and uses the
`review` command. Settings has a separate **Command line** row to install or
remove the `review` command; removal sticks across updates. Trace capture and Pi
use the command; MCP agents do not need it. Other agents can use the installed
`review api` command.

Earlier versions of Review installed authoring skills for each agent. Review
removes the copies it installed automatically.

## Review instructions

Agents read authoring guidance from the running Review server instead of from
installed files. With the MCP tools, the agent calls `review_get_instructions`;
from a terminal, it runs:

```sh
review api review_get_instructions '{}'
```

The default topic, `authoring`, returns the live or batch workflow selected by
the server's authoring mode, together with document-authoring guidance and a
self-review checklist. Other topics are `headless`, `prepared-worktrees`,
`scratchpad` (offered only when the scratchpad is on and Desktop is running),
and `trace-archaeology`. Pass one as `{"topic":"headless"}`.

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

With no target, `review install` installs every supported integration. For
Claude Code, Codex, Cursor, and OpenCode it writes the same Review MCP
registration as Desktop; for Pi it installs the pointer skill. When
`DEV_REVIEW_SERVER_DIR` selects a headless server, it writes no MCP entries;
agents there use `review api` or `review mcp`. Run `review install --help` for
the current target list.

## Provider boundary

Review runs locally, but a connected coding agent may send source code, prompts,
and context to its own model provider. Review does not change that provider's
privacy, retention, or billing terms. See [Privacy](privacy.md) for the data
Review itself sends.
