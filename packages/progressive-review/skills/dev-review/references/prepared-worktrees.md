# Prepared worktrees

Scaffold materializes one worktree for each pinned base and head commit. It
runs each configured `devfast.prepare` command in both worktrees.

Prepared worktrees let language servers resolve repository dependencies. The
configuration is local to one clone. Do not commit it.

## Configure preparation

Match the repository lockfile:

- `pnpm-lock.yaml`: `pnpm install --frozen-lockfile`
- `package-lock.json`: `npm ci`
- `yarn.lock`: `yarn install --immutable`
- `uv.lock`: `uv sync`
- `go.mod`: `go mod download`
- `Cargo.lock`: `cargo fetch`

Set the first command:

```sh
git config devfast.prepare '<install command>'
```

Append another command:

```sh
git config --add devfast.prepare '<next command>'
```

Commands run in file order. Add a focused library build when workspace exports
point to generated output. Do not build application targets without a clear
need.

For example:

```sh
git config --add devfast.prepare 'pnpm -r --filter "./packages/**" run build'
```

After the next scaffold, check one dependency link and its generated output in
`.git/dev-fast/worktrees/<commit>/`.

Prepare failure is soft. Scaffold keeps the worktree and prints the log path.
A `.prepared` marker stores the command-list hash. A configuration change runs
preparation again during the next scaffold or update.
