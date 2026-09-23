# Coding agents

<!--
Outline: Connect an agent -> Plugins -> Update from an earlier version -> Trace search
-> Whiteboard instructions -> Change review -> Architecture review -> Provider boundary.
-->

Whiteboard works with Claude Code, Codex, Cursor, OpenCode, and Pi. Each agent
connects to Whiteboard's MCP server; the running Whiteboard server supplies the
authoring instructions.

## Connect an agent

Whiteboard does not edit agent configuration. Instead, it gives you a prompt that
tells the agent to connect itself.

1. Open Whiteboard. Use the **Welcome** tab, or **Settings → Agents**.
2. Choose **Install whiteboard in PATH** if Whiteboard offers it. The connection
   runs `~/.local/bin/whiteboard`.
3. Choose **Copy prompt** next to your agent. **Show prompt** reveals the text
   so you can read it first.
4. Paste the prompt into a session of that agent.

The agent registers an MCP server named `whiteboard` in its user-level
configuration, not in the project. It replaces an existing `whiteboard` entry. The
server runs this command:

```text
command: sh
args:    ["-c", "exec \"$HOME/.local/bin/whiteboard\" mcp"]
```

Agents started from an app do not see your shell `PATH`, so the prompt uses
the full path through `sh`. When Whiteboard has no launcher in `~/.local/bin`, as
when it runs from source, the prompt registers `whiteboard` with args `["mcp"]`
instead. That form needs `whiteboard` on the agent's `PATH`.

The agent then deletes old skills that Whiteboard Desktop installed, reloads its
MCP tools or asks for a restart, and calls `session_get_instructions` to confirm
the connection.

Whiteboard does not check which agents are connected. Paste the prompt again at
any time; it replaces the existing entry. To disconnect an agent, remove its
`whiteboard` MCP server with that agent's own settings.

Whiteboard and Whiteboard Preview share one launcher, which connects to whichever app
is open. Run one at a time.

### From a terminal

`whiteboard connect` prints the same prompt that Desktop copies:

```sh
whiteboard connect codex
whiteboard connect claude cursor
whiteboard connect
```

With no agent, it prints the prompts for all five agents. Pass `--json` for a
`connect` event that maps each agent to its prompt.

### Agent differences

| Agent | Target | What the prompt sets up |
| --- | --- | --- |
| Claude Code | `claude` or `claude-code` | `whiteboard` MCP server |
| Codex | `codex` | `whiteboard` MCP server and one line in `~/.codex/AGENTS.md` |
| Cursor | `cursor` | `whiteboard` MCP server |
| OpenCode | `opencode` | `whiteboard` MCP server |
| Pi | `pi` | `whiteboard` skill in `~/.agents/skills` |

Codex finds MCP tools only when its instructions name them. Its prompt adds
this line to `~/.codex/AGENTS.md`: "For code reviews and explaining code, use
the `whiteboard` MCP server: call `session_get_instructions` first."

Pi has no MCP support. Its prompt writes a small `whiteboard` skill that runs
`whiteboard api session_get_instructions` through `~/.local/bin/whiteboard`.

## Plugins

Each agent also has a plugin or package that registers the same `whiteboard` MCP
server. Installing it replaces the paste step. The connect card shows the
install command, or the Cursor link, above **or paste this prompt**.

The npm packages and the Cursor listing are not published yet; the Claude Code
and Codex marketplace commands work once the plugins are on `main`.

| Agent | What installs | Install |
| --- | --- | --- |
| Claude Code | plugin with the `whiteboard` MCP server | `/plugin marketplace add devdotfast/review`, then `/plugin install whiteboard@devfast` |
| Codex | plugin with the `whiteboard` MCP server and a `whiteboard` skill | `codex plugin marketplace add devdotfast/review`, then `codex plugin add whiteboard@devfast` |
| Cursor | `whiteboard` MCP server | **Install in Cursor** on the connect card |
| OpenCode | npm plugin `@dev.fast/opencode-whiteboard` | add `"@dev.fast/opencode-whiteboard"` to `"plugin"` in `~/.config/opencode/opencode.json` |
| Pi | npm package `@dev.fast/pi-whiteboard` with the `whiteboard` skill | `pi install npm:@dev.fast/pi-whiteboard` |

Every plugin runs the same command as the prompt. Claude Code hides the
plugin's server when a user-level `whiteboard` server has the identical command,
so installing both does not create two servers.

The Cursor link needs `~/.local/bin/whiteboard`. Install the whiteboard command first.

Pi has no MCP support, so its package ships the skill instead of a server.

## Update from an earlier version

Earlier versions of Whiteboard installed skills into agent configuration. After
the update, Whiteboard opens an update screen once. It explains the change and
shows the same **Copy prompt** rows.

**Remove old Whiteboard skills** lists the skill directories it will delete, then
reports what it removed and what it left. It deletes only skills that Whiteboard
installed, which have `whiteboard-version` in their `SKILL.md` frontmatter. Skills
you wrote are left alone. Until nothing is left to remove, the button also
appears in **Settings → Agents**.

Choose **Done**, or close the tab, to dismiss the update screen.

## Trace search

While trace capture is on, the prompts for Claude Code, Codex, and Pi also set
up trace search with fff. The agent installs `~/.local/bin/fff-mcp` if it is
missing and registers a second MCP server named `fff` over Whiteboard's trace
search folder. Pi installs the `@ff-labs/pi-fff` package instead.

The prompt is generated when you copy it. If you turn on trace capture later,
copy the prompt again. Trace capture itself needs hooks in each agent; see
[Trace storage](cli-reference.md#trace-storage).

## Whiteboard instructions

Agents call the `session_get_instructions` tool; from a terminal, run
`whiteboard api session_get_instructions '{}'`. The default topic returns the authoring workflow.
Other topics are `file-lenses`, `scratchpad`, and `trace-archaeology`.

In normal use, ask your agent for a Whiteboard instead of running the lower-level
CLI commands yourself.

## Start a change whiteboard

```text
Create a Whiteboard of my current branch against up to date main, then open it
in Whiteboard.
```

You can replace “current branch” with a pull request URL or tell the agent which
base and head revisions to compare.

## Start an architecture review

An architecture session uses the same canvas without requiring a code diff. Ask
for the questions and system boundaries you care about:

```text
Create a Whiteboard that explains the main data flows, storage boundaries, and
critical code paths in this repository. Open it in Whiteboard when it is ready.
```

Specific context produces a better session. Tell the agent what you already
believe, which risks you care about, and where you want sequence or database
views.

## Provider boundary

Whiteboard runs locally, but a connected coding agent may send source code, prompts,
and context to its own model provider. Whiteboard does not change that provider's
privacy, retention, or billing terms. See [Privacy](privacy.md) for the data
Whiteboard itself sends.
