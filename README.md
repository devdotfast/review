<div align="center">
  <img
    src="packages/progressive-review/app/icons/review-icon.svg"
    width="88"
    alt="Review logo"
  />
  <h1>Review</h1>
  <p><strong>Your codebase, explained by your agent.</strong></p>
  <p>
    <a href="https://install.dev.fast">Download for macOS</a> ·
    <a href="docs/README.md">Docs</a> ·
    <a href="https://dev.fast">Website</a> ·
    <a href="CONTRIBUTING.md">Contributing</a>
  </p>
</div>

Review is an open-source desktop app for understanding large code changes. Your
coding agent turns a branch or pull request into a guided walkthrough of the
architecture, data flows, and decisions that matter, with the exact code always
one click away.

When agents can write thousands of lines in minutes, reading every changed line
is the wrong place to start. Review helps you understand the system first, then
inspect the implementation where it matters.

## What you can do

- **Read the story of a change.** Start with a focused explanation instead of
  a wall of diffs.
- **Move from explanation to code.** Follow anchored links, inspect live code,
  and jump to definitions with editor-grade navigation.
- **See how the system fits together.** Explore architecture maps, sequences,
  and database views alongside the review.
- **Close the loop with your agent.** Leave comments, ask questions, and send
  an approve or request-changes decision back to the authoring agent.

## Get started

> [!NOTE]
> Review is in alpha and currently ships for macOS on Apple silicon.

1. [Download Review](https://install.dev.fast) and open the app.
2. Connect Claude Code, Codex, or Cursor from the welcome screen.
3. Take the bundled three-minute tour.
4. Open your project in your coding agent and ask it to review your current
   branch against up-to-date main, then open the result in Review.

Review installs the command-line tools and skills your agent needs. The agent
creates the walkthrough; Review gives you the place to read it, explore the
code, and respond.

Read the [quickstart](docs/quickstart.md) for the complete first-review flow.

## Documentation

- [Quickstart](docs/quickstart.md)
- [How Review works](docs/how-review-works.md)
- [Coding agents](docs/agents.md)
- [CLI reference](docs/cli-reference.md)
- [Privacy](docs/privacy.md) and the full [telemetry reference](docs/telemetry.md)
- [Troubleshooting](docs/troubleshooting.md)

## Build from source

Review requires Node.js 24 and pnpm 11. See the full
[desktop prerequisites](apps/review-desktop/README.md#prerequisites), then run:

```sh
pnpm install
pnpm dev
```

The repository contains:

- [`apps/review-desktop`](apps/review-desktop) — the desktop app and pinned
  [Code - OSS](https://github.com/microsoft/vscode) fork.
- [`packages/progressive-review`](packages/progressive-review) — the Review
  CLI, local server, and interactive canvas.
- [`packages/review-protocol`](packages/review-protocol) — the contracts shared
  across Review processes.

Run `pnpm run ci` before submitting a pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md) for more.

## Privacy

Review runs against your local checkouts. Anonymous product telemetry does not
include your code, diffs, review text, comments, questions, prompts, or model
output. Coding agents may send data to their own providers, and an explicit bug
report can include only the attachments you choose in its consent controls.

Read the [privacy overview](docs/privacy.md) for the boundaries and opt-out
controls.

## License

Review is available under the [MIT License](LICENSE). The vendored Code - OSS
fork retains Microsoft's MIT license and third-party notices; see
[`apps/review-desktop/LICENSE`](apps/review-desktop/LICENSE) and
[`apps/review-desktop/UPSTREAM`](apps/review-desktop/UPSTREAM).
