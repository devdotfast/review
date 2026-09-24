<div align="center">
  <img
    src="docs/assets/review-logo.png"
    width="96"
    alt="Whiteboard logo"
  />
  <h1>Whiteboard</h1>
  <p><strong>an open-source IDE for thoughtful software design</strong></p>
  <p>
    <a href="https://install.dev.fast">Download for macOS</a> ·
    <a href="https://dev.fast">Website</a> ·
    <a href="https://discord.gg/wYvd2cpMQg">Discord</a>
  </p>
</div>

Whiteboard is an open-source desktop app where humans and agents can architect software together in a common workspace.

Whiteboard plugs into the tools you already use - e.g. Claude Code, Codex, etc. – and gives your agent an SDK to draw on an in-app canvas to describe its work.

<p align="center">
  <img
    src="docs/assets/whiteboard-demo.gif"
    width="880"
    alt="An agent draws a flow diagram on a Whiteboard next to the code it describes"
  />
</p>

Here’s a 1 min demo video explaining more: https://youtu.be/n3bPlt2KzCA

## Quickstart

1. [Download Whiteboard](https://install.dev.fast) and open the app.
2. Connect Claude Code, Codex, or another coding agent from the welcome screen.
3. Ask your agent to review your current branch against up-to-date main and
   open the result in Whiteboard.

## Why does this exist?

### Diagrams that lead to code

Walls of agent output in a terminal are a poor way to decide how a system
should work, and plain HTML diagrams can't connect a spec or plan back to the
code. Whiteboard is built on Code OSS: click a sequence diagram, an entity
relationship diagram, or a quote from the agent's trace to jump straight to the
underlying code, with VS Code keybindings and language support built in.

### Only the diff that matters

A raw diff of an agent's change is mostly noise. Whiteboard's semantic,
AST-aware diff viewer summarizes large added functions as pseudocode and
collapses tests and docs, so the changes that matter stand out. The rules are
customizable with WASM plugins.

### Every decision on the record

It's hard to tell which decisions an agent made on its own, or how they shaped
a change. Agents link their own traces on the Whiteboard, so you can see the
requirements you set, how they were implemented, and what the agent decided
autonomously.

### Open source, on your machine

Whiteboard is MIT-licensed and runs against your local checkouts. A hosted
product for teams is planned, and everything will always remain self-hostable.

## Contributing

Contributions and feedback are welcome.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request workflow,
and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as
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
  code fits into the pre-2025 notion of software engineering.
- Karpathy on agents:
  - On LLM agents: <https://x.com/karpathy/status/1979644538185752935>
  - On agents as "junior engineer savants":
    <https://x.com/karpathy/status/1915581920022585597>
