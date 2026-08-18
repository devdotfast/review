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

Review is an open-source desktop app for understanding and reviewing
agent-written code. Coding agents turn a branch or pull request into a guided,
interactive Review connected to the exact code behind it.

Explore architecture and data flow, inspect diffs, ask questions,
and explore coding traces from one interface.

> [!NOTE]
> Review is in alpha and currently ships for macOS on Apple silicon.

## Quickstart

1. [Download Review](https://install.dev.fast) and open the app.
2. Connect Claude Code, Codex, or Cursor from the welcome screen.
3. Ask your agent to review your current branch against up-to-date main and
   open the result in Review.

Review works especially well for large changes where a file-by-file diff does
not explain whether the system is right. See the
[quickstart](docs/quickstart.md) for the complete first-review flow.

## Documentation

[How Review works](docs/how-review-works.md) ·
[Architecture](docs/architecture.md) ·
[Coding agents](docs/agents.md) ·
[CLI](docs/cli-reference.md) ·
[Privacy](docs/privacy.md) ·
[Troubleshooting](docs/troubleshooting.md)

## Development

Review requires Node.js 24 and pnpm 11. See the
[desktop prerequisites](apps/review-desktop/README.md#prerequisites), then run:

```sh
pnpm install
pnpm dev
```

Run `pnpm run ci` before submitting a pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md) for more.

### A note on vendoring Code OSS

With everyone using dedicated agent TUIs and desktop apps, we only use our text editors for reviewing line-by-line diffs now, so we figured why not have a text editor meant for reviewing code. Might as well start off with the most successful open source editor out there.

We vendor Code OSS unlike other forks that maintain patches because coding agents have a hard time with patches and theres a lot of stuff from stock vscode (ie. ~45% of the codebase is copilot these days 😬) that we dont need. 

We regularly monitor upstream code oss and merge in security/feature patches as they come in.

## Privacy

Review runs against local checkouts. Anonymous telemetry does not include your
code, diffs, Review text, comments, questions, prompts, or model output. Read
the [privacy overview](docs/privacy.md), inspect the complete
[telemetry reference](docs/telemetry.md), or turn telemetry off at any time.

## License

Review is available under the [MIT License](LICENSE). The vendored Code - OSS
fork retains Microsoft's MIT license and third-party notices; see
[`apps/review-desktop/LICENSE`](apps/review-desktop/LICENSE) and
[`apps/review-desktop/UPSTREAM`](apps/review-desktop/UPSTREAM).
