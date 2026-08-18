# Coding agents

<!--
Outline: Supported agents -> Installed skills -> Change review -> Architecture review
-> Feedback loop -> Headless install -> Provider boundary.

TODO(docs):
- Confirm the supported-agent list and minimum versions for the launch build.
- Add links to the official setup/authentication docs for each supported agent.
- Decide whether Cursor should have a dedicated prompt instead of the generic flow.
- Add a short example showing a request-changes round returning to the same agent.
-->

Review works with the coding agent you already use. The desktop app installs a
small set of skills that teaches the agent how to author, validate, publish, and
update a Review.

## Supported agents

| Agent | Install target | Skill location |
| --- | --- | --- |
| Claude Code | `claude` or `claude-code` | `~/.claude/skills` |
| Codex | `codex` | `~/.agents/skills` |
| Cursor | `cursor` | `~/.cursor/skills` |

Review Desktop is the recommended installation path. On first launch it detects
installed agents, asks which integrations to enable, and keeps their skills in
sync with app updates. You can manage the integrations later from Review
settings.

## Installed skills

- `dev-review` authors and publishes a change review or architecture review.
- `dev-review-map` builds the base and head software maps used by the Map tab.

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

## Send feedback to the agent

Review threads have two modes:

- **Ask now** sends a question to the authoring agent immediately and keeps the
  answer in the same thread.
- **Add to review** holds a comment for the review decision. Choosing
  **Request changes** sends the submitted set back for another authoring round.

The agent updates the Review document, responds to the exact threads it
addressed, and publishes another validated revision. **Approve** and dismissal
are terminal states.

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
