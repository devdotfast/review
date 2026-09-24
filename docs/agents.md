# Coding agents

<!--
Outline: Connect an agent -> Plugins -> Update from an earlier version -> Trace search
-> Review instructions -> Change review -> Architecture review -> Provider boundary.
-->

Review works with Claude Code, Codex, Cursor, OpenCode, and Pi. Each agent
connects to Review's MCP server; the running Review server supplies the
authoring instructions.

## Connect an agent

Review does not edit agent configuration. Instead, it gives you a prompt that
tells the agent to connect itself.

1. Open Review. Use the **Welcome** tab, or **Settings → Agents**.
2. Choose **Install review in PATH** if Review offers it. The connection
   runs `~/.local/bin/review`.
3. Choose **Copy prompt** next to your agent. **Show prompt** reveals the text
   so you can read it first.
4. Paste the prompt into a session of that agent.

The agent registers an MCP server named `review` in its user-level
configuration, not in the project. It replaces an existing `review` entry. The
server runs this command:

```text
command: sh
args:    ["-c", "exec \"$HOME/.local/bin/review\" mcp"]
```

Agents started from an app do not see your shell `PATH`, so the prompt uses
the full path through `sh`. When Review has no launcher in `~/.local/bin`, as
when it runs from source, the prompt registers `review` with args `["mcp"]`
instead. That form needs `review` on the agent's `PATH`.

The agent then deletes old skills that Whiteboard Desktop installed, reloads its
MCP tools or asks for a restart, and calls `session_get_instructions` to confirm
the connection.

Review does not check which agents are connected. Paste the prompt again at
any time; it replaces the existing entry. To disconnect an agent, remove its
`review` MCP server with that agent's own settings.

Review and Review Preview share one launcher, which connects to whichever app
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
| Claude Code | `claude` or `claude-code` | `review` MCP server |
| Codex | `codex` | `review` MCP server and one line in `~/.codex/AGENTS.md` |
| Cursor | `cursor` | `review` MCP server |
| OpenCode | `opencode` | `review` MCP server |
| Pi | `pi` | `review` skill in `~/.agents/skills` |

Codex finds MCP tools only when its instructions name them. Its prompt adds
this line to `~/.codex/AGENTS.md`: "For code reviews and explaining code, use
the `review` MCP server: call `session_get_instructions` first."

Pi has no MCP support. Its prompt writes a small `review` skill that runs
`whiteboard api session_get_instructions` through `~/.local/bin/review`.

## Plugins

Each agent also has a plugin or package that registers the same `review` MCP
server. Installing it replaces the paste step. The connect card shows the
install command, or the Cursor link, above **or paste this prompt**.

The npm packages and the Cursor listing are not published yet; the Claude Code
and Codex marketplace commands work once the plugins are on `main`.

| Agent | What installs | Install |
| --- | --- | --- |
| Claude Code | plugin with the `review` MCP server | `/plugin marketplace add devdotfast/review`, then `/plugin install review@devfast` |
| Codex | plugin with the `review` MCP server | `codex plugin marketplace add devdotfast/review`, then `codex plugin add review@devfast` |
| Cursor | `review` MCP server | **Install in Cursor** on the connect card |
| OpenCode | npm plugin `@dev.fast/opencode-review` | add `"@dev.fast/opencode-review"` to `"plugin"` in `~/.config/opencode/opencode.json` |
| Pi | npm package `@dev.fast/pi-review` with the `review` skill | `pi install npm:@dev.fast/pi-review` |

Where each install comes from:

- Claude Code and Codex read the marketplace files at this repository's root
  (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) from
  the default branch on GitHub. What is on `main` is what installs; there is no
  release or package.
- OpenCode and Pi install from npm.
- Cursor uses the link on the connect card. A marketplace listing is separate.

Every plugin runs the same command as the prompt. Claude Code hides the
plugin's server when a user-level `review` server has the identical command,
so installing both does not create two servers.

The Cursor link needs `~/.local/bin/review`. Install the review command first.

Pi has no MCP support, so its package ships the skill instead of a server.

## Update from an earlier version

Earlier versions of Review installed skills into agent configuration. After
the update, Review opens an update screen once. It explains the change and
shows the same **Copy prompt** rows.

**Remove old Review skills** lists the skill directories it will delete, then
reports what it removed and what it left. It deletes only skills that Review
installed, which have `review-version` in their `SKILL.md` frontmatter. Skills
you wrote are left alone. Until nothing is left to remove, the button also
appears in **Settings → Agents**.

Choose **Done**, or close the tab, to dismiss the update screen.

## Trace search

While trace capture is on, the prompts for Claude Code, Codex, and Pi also set
up trace search with fff. The agent installs `~/.local/bin/fff-mcp` if it is
missing and registers a second MCP server named `fff` over Review's trace
search folder. Pi installs the `@ff-labs/pi-fff` package instead.

The prompt is generated when you copy it. If you turn on trace capture later,
copy the prompt again. Trace capture itself needs hooks in each agent; see
[Trace storage](cli-reference.md#trace-storage).

## Review instructions

Agents call the `session_get_instructions` tool; from a terminal, run
`whiteboard api session_get_instructions '{}'`. The default topic returns the authoring workflow.
Other topics are `file-lenses`, `scratchpad`, and `trace-archaeology`.

In normal use, ask your agent for a Review instead of running the lower-level
CLI commands yourself.

## Start a change review

```text
Create a Review of my current branch against up to date main, then open it
in Review.
```

You can replace “current branch” with a pull request URL or tell the agent which
base and head revisions to compare.

## Start an architecture review

An architecture Review uses the same canvas without requiring a code diff. Ask
for the questions and system boundaries you care about:

```text
Create a Review that explains the main data flows, storage boundaries, and
critical code paths in this repository. Open it in Review when it is ready.
```

Specific context produces a better Review. Tell the agent what you already
believe, which risks you care about, and where you want sequence or database
views.

## Provider boundary

Review runs locally, but a connected coding agent may send source code, prompts,
and context to its own model provider. Review does not change that provider's
privacy, retention, or billing terms. See [Privacy](privacy.md) for the data
Review itself sends.
