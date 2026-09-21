# Coding agents

<!--
Outline: Built-in setup -> Installed skills -> Change review -> Architecture review
-> Headless install -> Provider boundary.
-->

Review works with Claude Code, Codex, and other coding agents. The desktop app
installs a small set of skills that teaches the agent how to create, author,
validate, and update a Review through the Review API and MCP tools.

## Built-in setup

Review Desktop provides setup shortcuts for these agent-specific skill
locations:

| Agent | Install target | Skill location |
| --- | --- | --- |
| Claude Code | `claude` or `claude-code` | `~/.claude/skills` |
| Codex | `codex` | `~/.agents/skills` |
| Cursor | `cursor` | `~/.cursor/skills` |

Other coding agents that follow the shared Agent Skills convention can load the
same Review skills from `~/.agents/skills`.

Review Desktop is the recommended installation path. On first launch it detects
installed agents, asks which integrations to enable, and keeps their skills in
sync with app updates. Generated skills carry the Review Desktop release version in
`SKILL.md` frontmatter. On the first launch after an update, Desktop replaces
older skills for enabled integrations automatically, including local edits.
Skills already at the bundled version are left alone. Start a new agent session
to load refreshed skills. Reinstall from settings to repair same-version edits
or missing supporting files; terminal-only installs are not automatically enrolled. You can manage the integrations later from Review
settings.

For Codex and Claude Code, Desktop setup also registers a user-level `review`
MCP connection. It launches a small adapter using Review's bundled runtime; no
separate Node installation, agent CLI, port, or token configuration is needed.
The desktop server remains the owner of every review. Other agents can use the
installed `review api` command.

App updates refresh the adapter along with enabled integrations and repair missing
MCP entries. Reinstall in settings runs the same setup again. Review leaves
customized MCP entries alone and explains how to replace them if desired;
uninstall removes only unchanged entries it created. Restart the agent or
reconnect its MCP server after setup. Start a new session for updated skills.

This automatic MCP setup belongs to the Desktop integration flow. The
terminal-only `review install` command still installs skills and the CLI only.

## Installed skills

- `dev-review` authors change and architecture reviews, including software maps.

The authoring skill coordinates the whole workflow. In normal use, ask your
agent for a Review instead of running the lower-level CLI commands yourself.

## Start a change review

Codex:

```text
Use $dev-review to review my current branch against up to date main, then open
it in Review.
```

Claude Code:

```text
Use the dev-review skill to review my current branch against up to date main,
then open it in Review.
```

In Cursor, choose `dev-review` from the `/` menu and give it the same request.

You can replace “current branch” with a pull request URL or tell the agent which
base and head revisions to compare.

## Start an architecture review

An architecture Review uses the same canvas without requiring a code diff. Ask
for the questions and system boundaries you care about:

```text
Use the Review skill to explain the main data flows, storage boundaries, and
critical code paths in this repository. Open it in Review when it is ready.
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

With no target, `review install` installs every supported integration. Run
`review install --help` for the current target list.

## Provider boundary

Review runs locally, but a connected coding agent may send source code, prompts,
and context to its own model provider. Review does not change that provider's
privacy, retention, or billing terms. See [Privacy](privacy.md) for the data
Review itself sends.
