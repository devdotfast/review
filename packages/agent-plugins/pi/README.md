# Whiteboard for Pi

A Pi package that ships the `whiteboard` skill. Pi has no MCP support, so the
skill tells Pi to call Whiteboard through the command line
(`"$HOME/.local/bin/whiteboard" api ...`).

## Install

Requires Whiteboard Desktop with the `whiteboard` command installed (Settings →
Command line).

```sh
pi install npm:@dev.fast/pi-whiteboard
```

Verified with Pi 0.86.1 against a local checkout, using a scratch
`PI_CODING_AGENT_DIR` and `HOME`: `pi install <checkout>/packages/agent-plugins/pi`,
then the RPC `get_commands` call listed `skill:whiteboard` from this package.
Installing from npm was not exercised. A user-level `whiteboard` skill from an
older Whiteboard setup takes precedence over this one; the Connect card removes
those.
