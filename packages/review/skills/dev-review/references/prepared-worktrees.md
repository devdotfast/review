# Prepared worktrees

- **Live** (`target.kind: "worktree"`): follows saved files in the registered checkout. LSP uses that checkout's dependencies; Review does not run `devfast.prepare` there.
- **Pinned** (`target.kind: "commits"`): keeps reviewed source fixed at base/head commits. LSP uses separate Review-owned checkouts; your working checkout's dependencies are not automatically available.
- **Prepared**: a pinned checkout whose configured setup commands succeeded. This is setup status, not another review mode. An unprepared checkout may still provide working LSP.

## Configure preparation

Before opening a pinned review, configure the repository's established setup
command if language features need dependencies or generated files. Inspect
`git config --get-all devfast.prepare` first and preserve existing commands.
The configuration is local to the clone; do not commit it.

Match the project's lockfile and package manager. Examples include
`pnpm install --frozen-lockfile`, `npm ci`, `uv sync`, `go mod download`, and
`cargo fetch`. Use the repository's own setup instructions when they differ.

Set the first command when none is configured:

```sh
git config devfast.prepare 'pnpm install --frozen-lockfile'
```

Append a required generation or focused library-build step when language
resolution depends on its output:

```sh
git config --add devfast.prepare 'pnpm generate'
```

Commands run in order inside each pinned worktree when `review_open` acquires
the environments. Historical and selected-commit environments are acquired on
demand. Successful preparation is cached by checkout and command-list hash;
changing the commands causes preparation to run again on acquisition.

## Diagnose actual failures

Missing configuration does not mean LSP is broken. A failed prepare command is
also soft: language services still attempt to use the same checkout. Do not
declare the environment broken from preparation status alone, or add setup
warnings to the authored review. Projects whose language features already work
need no prepare command.

`review_open` includes `environmentIssues` only when a language checkout is
unavailable. Restore the missing repository or address the reported checkout
failure, then call `review_environment({reviewId})` to reacquire and recheck.
The tool returns `{issues:[]}` when it finds no checkout-availability problem;
this is not an end-to-end LSP health check. If a language feature actually fails,
investigate that failure and the project's dependency requirements before
changing setup.
