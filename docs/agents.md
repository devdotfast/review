# Coding agents

<!--
Outline: Built-in setup -> Installed skills -> API connection -> Change review
-> Architecture review -> Feedback -> Terminal install -> Provider boundary.
-->

Review works with Claude Code, Codex, and other coding agents. The desktop app
installs a small set of skills that teaches the agent how to author, validate,
publish, and update a Review.

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

## Installed skills

- `dev-review` authors JSON nodes and publishes change or architecture reviews.
- `dev-review-map` creates versioned base/head maps through the same host API.

The authoring skill coordinates the whole workflow. In normal use, ask your
agent for a Review instead of running the lower-level CLI commands yourself.

## Connect to the host

Desktop must be running. The matching CLI can call it directly:

```sh
review host capabilities
```

For MCP, configure your agent's stdio server entry to run the matching `review`
executable with `mcp` as its argument. Setup installs skills and the CLI shim;
it does not currently create that MCP configuration. Use the agent's own MCP
configuration interface rather than copying guessed settings.

The stdio process is a thin client of Desktop, not a second review server.
It advertises the operations allowed by its credential. Neither CLI nor MCP
reads review documents or comment databases directly. See the
[CLI and API reference](cli-reference.md) for command shapes and discovery.

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

## Feedback and Ask are deferred

Comments, feedback submission and Ask are unavailable for JSON reviews in this authoring-only version. They are deferred to the third PR in this stack.

Authors can continue updating JSON documents and publish new checkpoints. Do not
use the retired file-backed commands as a feedback workaround. The bundled
tutorial's attached question utility is a separate trusted legacy exception.

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

Review runs locally, but an authoring agent may send source, prompts and context
to its own model provider. Review does not change the provider's privacy,
retention or billing terms. See [Privacy](privacy.md) for the data Review itself
sends. The JSON host does not launch question agents in this version.
