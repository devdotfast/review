# Contributing to Whiteboard

Thanks for contributing to Whiteboard. We welcome bug reports, fixes, and new
features. By participating, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Open an issue before starting anything significant. Describe the problem and
your proposed approach, and wait for a maintainer to confirm it before you
write code. This avoids duplicate work and catches design constraints early.
Small fixes, such as typos and obvious bugs, can go straight to a pull request.

Check [open issues](https://github.com/devdotfast/review/issues) first.
Questions are welcome on [Discord](https://discord.gg/wYvd2cpMQg).

Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Setup

Whiteboard requires Node.js 24 and pnpm 11. See the
[desktop prerequisites](apps/review-desktop/README.md#prerequisites), then run
from the repository root:

```sh
pnpm install
pnpm dev
```

A dev build can run alongside an installed Whiteboard. They share the same
data, so commands and your agent's `whiteboard` MCP server talk to one selected
app. Run `whiteboard instances` to see which one, `whiteboard instances use
<key>` to change the default, or set `DEV_REVIEW_INSTANCE=<key>` in the shell
you start your agent from. Reconnect the MCP server after switching.

## Repository layout

The product is named Whiteboard, but package names and directories still use
`review`.

- `apps/review-desktop/` contains the desktop app, packaging scripts, and the
  vendored Code - OSS fork. See
  [apps/review-desktop/README.md](apps/review-desktop/README.md) for build,
  packaging, and release details, and
  [apps/review-desktop/UPSTREAM](apps/review-desktop/UPSTREAM) for the
  Code - OSS source revision and fork differences.
- `packages/review/` contains the `whiteboard` command-line interface, embedded
  server, and canvas.
- `packages/review-protocol/` contains the shared process contracts.
- `packages/trace-core/` and `packages/trace-protocol/` contain agent trace
  capture and the hosted trace store contract.
- `packages/agent-plugins/` contains the plugins and skills for supported
  coding agents.
- `packages/local-vcs/` contains local version-control helpers.

The files under `apps/review-desktop/code-oss/` include upstream contribution
and security documents. Those files apply to Microsoft's VS Code project; this
document and [SECURITY.md](SECURITY.md) apply to Whiteboard.

## Testing

Run the full check suite before you open a pull request:

```sh
pnpm run ci
```

DOM-facing tests run in Chromium through Vitest Browser Mode. Install the
browser once, then run the headless suite or watch mode:

```sh
pnpm --filter @dev.fast/review exec playwright install chromium
pnpm --filter @dev.fast/review test:browser
pnpm --filter @dev.fast/review test:browser:watch
```

Pure Node, filesystem, and server tests run through
`pnpm --filter @dev.fast/review test:node`.

`pnpm --filter @dev.fast/review test:legacy-corpus` replays a private corpus of
legacy Reviews (from before the Whiteboard rename) through migration. Point
`REVIEW_LEGACY_CORPUS` at a directory whose children are Review UUID folders;
the script fails if the variable is unset. The corpus is copied before it is
touched and the originals are re-verified afterwards.

Test behavior, not implementation. Do not add
[change detector tests](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html).
If you find one, delete it instead of updating it, and say so in your pull
request.

## Pull requests

Work on a branch, and keep each pull request focused on one change. Avoid
mixing refactors, docs, and features unless they are tightly related.

Write the pull request title as a short, plain-language summary of the change,
such as "Keep code evidence loading until its comparison resolves". In the
description:

- link the issue it addresses;
- describe the behavior you added or changed;
- explain how you validated it; and
- call out anything reviewers should pay attention to, such as stored-data
  migrations, telemetry changes, or changes to the vendored Code - OSS fork.

If your change adds or changes telemetry, update
[docs/telemetry.md](docs/telemetry.md) in the same pull request.
