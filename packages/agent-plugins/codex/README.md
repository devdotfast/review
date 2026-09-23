# Whiteboard for Codex

A Codex plugin that registers Whiteboard's MCP server and ships a small
`whiteboard` skill, so Codex knows to call the `whiteboard` tools.

## Install

Requires Whiteboard Desktop with the `whiteboard` command installed (Settings →
Command line); the plugin launches `$HOME/.local/bin/whiteboard mcp`.

```sh
codex plugin marketplace add devdotfast/review
```

Then run `/plugins` in the Codex TUI and install `whiteboard`, or install it from
the shell with `codex plugin add whiteboard@devfast`. `codex mcp list` should show
`whiteboard`.

Verified with codex-cli 0.155.1 against a local checkout:
`codex plugin marketplace add <checkout>`, `codex plugin add whiteboard@devfast`,
then `codex mcp list` showed `whiteboard` with the shared launch command. The
`/plugins` TUI step was not exercised.
