# Whiteboard for OpenCode

An OpenCode plugin whose `config` hook registers Whiteboard's MCP server as
`whiteboard`.

## Install

Requires Whiteboard Desktop with the `whiteboard` command installed (Settings →
Command line); the plugin launches `$HOME/.local/bin/whiteboard mcp`.

Add the package to the `plugin` list in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@dev.fast/opencode-whiteboard"]
}
```

`opencode mcp list` should then show `whiteboard`.

Verified with OpenCode 1.18.30 against a local checkout, using a scratch
`XDG_CONFIG_HOME` whose `opencode.json` listed this directory as a plugin:
`opencode mcp list` showed `whiteboard` connected with the shared launch command,
and `GET /mcp` on `opencode serve` returned `{"whiteboard":{"status":"connected"}}`.
On 1.18.30 the config hook runs before OpenCode starts its MCP servers, so
the plugin needs no runtime fallback; earlier versions are untested. Installing from npm was not exercised.
