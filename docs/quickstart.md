# Quickstart

<!--
Outline: Requirements -> Install -> Tour -> Create -> Respond -> Verify -> Next steps.
-->

This guide takes you from a fresh install to a completed first review.

## Requirements

- An Apple silicon Mac.
- A Git or Jujutsu repository with a branch, bookmark, change, or pull request
  to review.
- Claude Code, Codex, and other coding agents.

## 1. Install Whiteboard

[Download the latest disk image](https://install.dev.fast), open it, and launch
Whiteboard. The app updates itself after installation.

On first launch, Whiteboard opens the welcome screen. Its first step connects your
coding agents:

1. Choose **Install whiteboard in PATH**.
2. Choose **Copy prompt** next to an agent you use.
3. Paste the prompt into a session of that agent. The agent registers Whiteboard's
   MCP server and confirms that it can reach Whiteboard.

Repeat for each agent. You can copy the prompts again later from
**Settings → Agents**. See [Coding agents](agents.md#connect-an-agent) for
what the prompt does.

## 2. Take the tour

Open the bundled three-minute tour from the welcome screen. It uses a real local
sample repository to show:

- explanations linked to live code;
- hover, go-to-definition, and code peeks;
- sequence and database views; and
- the full architecture map.

## 3. Create a session

Open the repository you want to review in your coding agent and tell it to
review it!

```text
Create a Whiteboard of my current branch against up to date main, then open it
in Whiteboard.
```

The agent registers the repository, resolves the base and head pins, creates
the session through the Whiteboard API, writes and validates the walkthrough, and
opens it in Whiteboard. You can also review a specific GitHub pull request
or ask for an architecture review of a repository.

<a id="add-review-guidance"></a>

### Add Whiteboard guidance

You can add optional guidance for generated session documents:

- User-level guidance: `$DEV_WHITEBOARD_HOME/DEV-REVIEW.md`. Whiteboard uses
  `~/.dev/DEV-REVIEW.md` by default.
- Repository guidance: `DEV-REVIEW.md` at the source repository root.

Repository guidance takes precedence over user-level guidance.

## 4. Read the session

Use the three main surfaces together:

- **Session** explains the change and links every code claim to its evidence.
- **Map** lets you move from systems to containers, components, and code
  (experimental).
- **Files** shows the underlying changed-file diff.

## Verify the command-line setup

The app normally manages the CLI. These commands are useful for checking it:

```sh
whiteboard version
whiteboard app launch
whiteboard info
```

If the command is missing or behaves like an older browser-based Whiteboard, see
[Troubleshooting](troubleshooting.md).

## Next steps

- Learn [how Whiteboard works](how-review-works.md).
- Read about [coding-agent setup](agents.md).
- Use the [CLI reference](cli-reference.md) for explicit or automated flows.
- Read the [privacy boundaries](privacy.md).
