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

## 1. Install Review

[Download the latest disk image](https://install.dev.fast), open it, and launch
Review. The app updates itself after installation.

On first launch, Review opens the welcome screen. It detects supported coding
agents and offers to install:

- the `review` command in `~/.local/bin`;
- the `dev-review` skill for authoring reviews; and
- the `dev-review-map` skill for generating architecture maps.

Choose **Install** for the agents you use. Review keeps the app-managed command
and skills in sync after updates.

## 2. Take the tour

Open the bundled three-minute tour from the welcome screen. It uses a real local
sample repository to show:

- explanations linked to live code;
- hover, go-to-definition, and code peeks;
- code comments and agent questions;
- sequence and database views; and
- the full architecture map.

## 3. Create a review

Open the repository you want to review in your coding agent and tell it to
review it!

```text
Use the dev-review skill to review my current branch against up to date main,
then open it in Review.
```

The agent scaffolds a Review, writes and validates the walkthrough, publishes
it, and opens it in Review Desktop. You can also review a specific GitHub pull
request or ask for an architecture review of a repository.

### Add Review guidance

You can add optional guidance for generated Review documents:

- User-level guidance: `$DEV_REVIEW_HOME/DEV-REVIEW.md`. Review uses
  `~/.dev/DEV-REVIEW.md` by default.
- Repository guidance: `DEV-REVIEW.md` at the source repository root.

Repository guidance takes precedence over user-level guidance.

## 4. Read and respond

Use the three main surfaces together:

- **Review** explains the change and links every code claim to its evidence.
- **Map** lets you move from systems to containers, components, and code
  (experimental).
- **Files** shows the underlying changed-file diff.

Leave an anchored comment where something should change, or use **Ask now** for
a question the agent can answer immediately. When you finish, choose **Approve**
or **Request changes**. A request-changes round returns your comments to the
authoring agent so it can update and republish the walkthrough.

## Verify the command-line setup

The app normally manages the CLI. These commands are useful for checking it:

```sh
review version
review app launch
review info
```

If the command is missing or behaves like an older browser-based Review, see
[Troubleshooting](troubleshooting.md).

## Next steps

- Learn [how Review works](how-review-works.md).
- Read about [coding-agent setup](agents.md).
- Use the [CLI reference](cli-reference.md) for explicit or automated flows.
- Review the [privacy boundaries](privacy.md).
