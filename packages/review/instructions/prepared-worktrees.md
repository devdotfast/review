# Prepared worktrees

- **Live** (`worktree`): follows saved files and uses the existing checkout's dependencies. No preparation runs.
- **Pinned** (`commits`): fixed source at base/head commits; LSP uses separate checkouts without your working checkout's dependencies.
- **Prepared**: setup succeeded in a pinned checkout, not a separate review mode.

Before `review_open`, configure preparation only if pinned LSP needs dependencies
or generated files. Read `git config --get-all devfast.prepare` and preserve
existing commands. Use the repository's normal setup, for example:

```sh
git config devfast.prepare 'pnpm install --frozen-lockfile'
```

Use `git config --add devfast.prepare '<command>'` for required generation steps.
Commands run in order in the pinned checkouts; configuration is local to the clone.

Missing or failed preparation does not prove LSP is broken. Keep setup warnings
out of the review. `review_open` starts acquisition in the background and reports
known issues. Use `review_environment({reviewId})` to recheck current base/head
checkouts; acquisition errors may be transient. If a language feature fails after
failed setup, use `review_environment({reviewId,retry:true})` to rerun preparation.
No issues is not proof of LSP health. `review_workspace_cleanup` lists failed
cleanup of retired checkouts; pass `workspaceId` to retry cleanup.
