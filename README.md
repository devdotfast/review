<div align="center">
  <img
    src="docs/assets/review-logo.png"
    width="96"
    alt="Review logo"
  />
  <h1>Review</h1>
  <p><strong>Cursor for code review.</strong></p>
  <p>
    <a href="https://install.dev.fast">Download for macOS</a> ·
    <a href="docs/README.md">Docs</a> ·
    <a href="https://dev.fast">Website</a> ·
    <a href="CONTRIBUTING.md">Contributing</a>
  </p>
</div>

## TL;DR

Review is an open-source desktop app for developers to understand the intent
behind a change, read code diffs, explore interactive diagrams, and leave
comments from one interface. It is like Cursor, but purpose-built for code
review.

Try it on your toughest reviews. Review shines on large, complicated changes
where reading a diff from top to bottom tells you the least about whether the
system is right.

<!-- TODO(docs): Embed the launch demo video or GIF here. -->

## The problem

Models can write a lot of code, very fast. No one knows how much of it humans
should be reading.

AI can find a vulnerability in the Linux kernel one minute and bungle your data
architecture the next. A change can look reasonable file by file while still
being wrong at the system level.

Most code review tools assume the diff is the artifact. That works when changes
are small. It breaks down when a pull request spans thousands of lines, crosses
several systems, or was produced by an agent faster than a human could have
written it.

We are confident about one thing: understanding your codebase still matters.
Building software is a long game, especially when customers depend on it.

## The approach

Even before AI, staff engineers had to understand software systems too large to
read line by line. They managed the complexity by:

- skipping low-risk implementation details; and
- reading RFCs, architecture, and data flows before diving into code.

Review brings that workflow to agent-written code. Your coding agent turns a
branch or pull request into a programmatic, customizable RFC connected to the
exact code behind it.

Instead of starting with a 1,000-line diff, you can:

- understand what the change is trying to do and which decisions it made;
- explore architecture maps, sequence diagrams, and database access patterns;
- audit the agent's claims by jumping directly to live code and definitions;
- open the underlying changed-file diff whenever you need it; and
- leave comments, ask questions, then approve or request changes from the same
  interface.

Review does not hide the code. It gives you a better way to decide which code
deserves your attention.

## Try Review

> [!NOTE]
> Review is in alpha and currently ships for macOS on Apple silicon.

1. [Download Review](https://install.dev.fast) and open the app.
2. Connect Claude Code, Codex, or Cursor from the welcome screen.
3. Take the bundled three-minute tour.
4. Ask your coding agent to review your current branch against up-to-date main
   and open the result in Review.

Review installs the command-line tools and skills your agent needs. The agent
creates the walkthrough; Review gives you the place to read it, interrogate it,
and respond.

Read the [quickstart](docs/quickstart.md) for the complete first-review flow.

## Open source, on purpose

Code review is a trust boundary. Teams should be able to inspect, extend, and
run the software they use to decide what enters their codebase. Review Desktop
is MIT licensed and developed in the open.

We are also building a paid hosted product, currently in alpha with a small
group of design partners. Our long-term goal is an agent-native GitLab: a place
where agents can write more of the code without lowering the standard of human
judgment applied to it.

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
