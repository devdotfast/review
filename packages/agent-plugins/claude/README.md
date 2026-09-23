# Whiteboard for Claude Code

A Claude Code plugin that registers Whiteboard's MCP server.

## Install

Requires Whiteboard Desktop with the `whiteboard` command installed (Settings →
Command line).

```
/plugin marketplace add devdotfast/review
/plugin install whiteboard@devfast
```

If you already added a user-level `whiteboard` server with a different command,
remove it so Claude Code does not run two servers:

```
claude mcp remove -s user whiteboard
```

Verified with: Claude Code 2.1.280 (`claude plugin validate`, then marketplace add, install and `claude mcp list` showing `plugin:whiteboard:whiteboard` connected).
