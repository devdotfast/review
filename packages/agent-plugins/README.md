# Agent plugins

Plugins and packages that register Whiteboard's MCP server (or its pointer skill)
with each agent harness, so connecting an agent becomes an install command
instead of a pasted prompt.

## Layout

One directory per harness under `packages/agent-plugins/<harness>/`:

| Directory | Harness | Shape |
| --- | --- | --- |
| `claude/` | Claude Code | plugin: `.claude-plugin/plugin.json` + `.mcp.json` |
| `codex/` | Codex | plugin: `.codex-plugin/plugin.json` + `.mcp.json` + `skills/` |
| `cursor/` | Cursor | plugin: `.cursor-plugin/plugin.json` + `mcp.json`; the connect card also offers a deeplink |
| `opencode/` | OpenCode | npm package `@dev.fast/opencode-whiteboard` whose `config` hook sets `cfg.mcp.whiteboard` |
| `pi/` | Pi | npm package `@dev.fast/pi-whiteboard` shipping `skills/whiteboard/SKILL.md` |

The Claude Code and Codex marketplace files (`.claude-plugin/marketplace.json`
and `.agents/plugins/marketplace.json`) sit at the repo root and point into
this directory.

## Distribution

| Harness | Source | Publish step |
| --- | --- | --- |
| Claude Code, Codex | this repo's default branch, via the root marketplace files | none; merge to `main` |
| OpenCode, Pi | npm (`@dev.fast/opencode-whiteboard`, `@dev.fast/pi-whiteboard`) | `npm publish --access public` |
| Cursor | deeplink on the connect card | none; marketplace listing is a manual submission |

Anything on `main` under `packages/agent-plugins/claude` or `codex` is live for
new installs immediately; the manifest test below is the guard.

## The launch command

Every MCP registration Whiteboard hands out, in prompts and in these plugins, uses
one launch form:

```
command: sh
args:    ["-c", "exec \"$HOME/.local/bin/whiteboard\" mcp"]
```

GUI-launched harnesses (Cursor, and Claude Code or Codex started from an app)
do not see the shell PATH, so a bare `whiteboard` fails; Codex plugins and the
shared Agent Plugins manifest expand no variables in `command`, so `${HOME}` is
not portable; `/bin/sh` is always present and expands `$HOME` itself. Claude
Code hides a plugin's server when a user-level server has the identical command
and args, so keeping the prompt and the plugin byte-identical avoids duplicate
`whiteboard` servers. The constant lives in one place (`WHITEBOARD_MCP_LAUNCH` in
`packages/whiteboard/src/connect-prompts.ts`), and
`packages/whiteboard/src/agent-plugins.test.ts` checks every manifest against it.
Add each new manifest to `MANIFESTS` in that test.

## Publishing checklist

Nothing here is published yet. To publish:

1. Merge the pull request that adds these plugins.
2. Run `npm publish --access public` in `packages/agent-plugins/opencode` and
   in `packages/agent-plugins/pi`.
3. The Claude Code and Codex marketplace files are live on `main` once merged;
   nothing else to publish for those two.
4. Submit the Cursor plugin at cursor.com/marketplace/publish. The listing
   needs a manual review; the connect card's deeplink works without it.
5. Tell users in the release notes.
