<div align="center">
  <img
    src="docs/assets/review-logo.png"
    width="96"
    alt="Whiteboard logo"
  />
  <h1>Whiteboard</h1>
  <p><strong>Cursor for code review.</strong></p>
  <p>
    <a href="https://install.dev.fast">Download for macOS</a> ·
    <a href="https://dev.fast">Website</a> ·
    <a href="https://discord.gg/wYvd2cpMQg">Discord</a>
  </p>
</div>

Whiteboard is an open-source desktop app for understanding and reviewing
agent-written code. Coding agents turn a branch or pull request into a guided,
interactive Whiteboard connected to the exact code behind it.

Explore architecture and data flow, inspect diffs, and explore coding traces
from one interface.

<p align="center">
  <img
    src="docs/assets/whiteboard-overview.png"
    width="880"
    alt="Whiteboard showing a guided code review and interactive sequence diagram"
  />
</p>

## Quickstart

1. [Download Whiteboard](https://install.dev.fast) and open the app.
2. Connect Claude Code, Codex, or another coding agent from the welcome screen.
3. Ask your agent to review your current branch against up-to-date main and
   open the result in Whiteboard.

## Why vendor Code OSS?

With everyone using dedicated agent TUIs and desktop apps, we only use our text
editors for reviewing line-by-line diffs now, so we figured why not have a text
editor meant for reviewing code. In that case, might as well start off with the
most successful open source editor out there as a baseline.

We vendor Code OSS unlike other forks that maintain patches because coding
agents have a hard time with patches and there's a lot of stuff from stock VS
Code (i.e., ~45% of the codebase is Copilot these days 😬) that we don't need.

We regularly monitor upstream Code OSS and merge in security/feature patches as
they come in.

## Contributing

We welcome bug reports, fixes, and features. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request workflow, and
follow our [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as
described in [SECURITY.md](SECURITY.md). Questions? Ask on
[Discord](https://discord.gg/wYvd2cpMQg).

## Privacy

Whiteboard runs against local checkouts. Anonymous telemetry does not include
your code, diffs, Whiteboard text, prompts, or model output. Read the
[privacy overview](docs/privacy.md), inspect the complete
[telemetry reference](docs/telemetry.md), or turn telemetry off at any time.

## License

Whiteboard is available under the [MIT License](LICENSE). The vendored Code -
OSS fork retains Microsoft's MIT license and third-party notices; see
[`apps/review-desktop/LICENSE`](apps/review-desktop/LICENSE) and
[`apps/review-desktop/UPSTREAM`](apps/review-desktop/UPSTREAM).

## Influences

- <https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck>
  — a great overview of the constraints of modern software engineering.
- <https://maggieappleton.com/2025-08-vibe-legacy-code/> and
  <https://blog.val.town/vibe-code> — do a great job describing how AI-generated
  code fits into our pre-2025 notion of software engineering.
- We're big fans of Karpathy, so here are some of his banger tweets we love
  discussing:
  - On LLM agents: <https://x.com/karpathy/status/1979644538185752935>
  - On agents as "junior engineer savants":
    <https://x.com/karpathy/status/1915581920022585597>
